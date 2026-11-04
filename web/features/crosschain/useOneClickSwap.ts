"use client";

import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { useCallback, useEffect, useMemo, useState } from "react";

import { config } from "@/config";
import type { ChainId } from "@/config/deployment";
import { type ClockAnchor, type SwapStatus, addressView, remainingMs } from "@/lib/crosschain/clock";
import { createOneClick } from "@/lib/crosschain/client";
import { echoMatches } from "@/lib/crosschain/echo";
import { type QuoteInput, type QuoteRequest, createRequestBuilder } from "@/lib/crosschain/request";
import { verifyQuote } from "@/lib/crosschain/signature";
import { type StoredSwap, createSwapStore, swapKey } from "@/lib/crosschain/store";

/** 1Click status poll; a test build polls faster so e2e steps do not race it. */
const POLL_MS = config.testBuild ? 1_000 : 5_000;
const TICK_MS = 1_000;

export interface Live {
  swap: StoredSwap;
  request: QuoteRequest;
  signed: OneClickQuoteResponse;
  anchor: ClockAnchor;
  needsReanchor: boolean;
  confirmNotSent: boolean;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function checkQuote(req: QuoteRequest, res: OneClickQuoteResponse): string | null {
  if (!verifyQuote(res, config.oneClick?.quotePublicKey ?? "")) return "The quote's signature did not verify, so no address is shown.";
  const echo = echoMatches(req, res);
  if (!echo.ok) return `The quote does not match what was asked (${echo.field}), so no address is shown.`;
  return null;
}

/** 1Click calls, the stored swaps, the status poll, and the clock for the live deposit address. */
export function useOneClickSwap(unreadable: boolean) {
  const oc = config.oneClick!;
  const client = useMemo(() => createOneClick(oc.baseUrl), [oc.baseUrl]);
  const build = useMemo(() => createRequestBuilder(), []);
  const store = useMemo(() => createSwapStore(storage(), swapKey(config.network, config.vaultId)), []);
  const [swaps, setSwaps] = useState<StoredSwap[]>(() => {
    if (typeof window === "undefined") return [];
    store.prune();
    return store.list();
  });
  const [tokens, setTokens] = useState<{ assetId: string; contractAddress?: string }[] | null>(null);
  const [down, setDown] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<{ status: SwapStatus | string; raw: unknown } | null>(null);
  const [now, setNow] = useState(() => ({ perf: performance.now(), date: Date.now() }));

  useEffect(() => {
    const off = store.onChange(() => setSwaps(store.list()));
    client.tokens().then((t) => setTokens(t as { assetId: string }[]), () => setDown(true));
    return off;
  }, [store, client]);

  const save = useCallback((s: StoredSwap) => {
    store.upsert(s);
    setSwaps(store.list());
  }, [store]);

  const quote = useCallback(async (input: Omit<QuoteInput, "destinationAsset" | "dry">, dry: boolean) => {
    const req = build({ ...input, dry, destinationAsset: `nep141:${config.usdc}` });
    const res = await client.quote(req);
    return { req, res, problem: checkQuote(req, res) };
  }, [build, client]);

  // Status poll for the live swap and every unfinished stored swap.
  useEffect(() => {
    const addr = live?.swap.depositAddress;
    if (!addr) return;
    let alive = true;
    const poll = () =>
      client.status(addr).then(
        (r) => alive && setStatus(r === "not-found" ? { status: "not-found", raw: null } : r),
        () => alive && setStatus({ status: "unknown", raw: null }),
      );
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, live?.swap.depositAddress]);

  // Swaps saved before a reload: read their status too and write a final one back.
  useEffect(() => {
    const open = swaps.filter((w) => w.final === null && w.depositAddress && w.depositAddress !== live?.swap.depositAddress);
    if (open.length === 0) return;
    let alive = true;
    const poll = () =>
      open.forEach((w) =>
        client.status(String(w.depositAddress)).then(
          (r) => {
            if (!alive || r === "not-found") return;
            if (r.status === "SUCCESS" || r.status === "REFUNDED" || r.status === "FAILED") save({ ...w, final: r.status });
          },
          () => {},
        ),
      );
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, swaps, save, live?.swap.depositAddress]);

  // The clock, and re-anchoring after the tab was hidden (performance.now can stop while asleep).
  useEffect(() => {
    if (!live) return;
    const tick = () => setNow({ perf: performance.now(), date: Date.now() });
    tick();
    const t = setInterval(tick, TICK_MS);
    const hidden = () => setLive((l) => (l ? { ...l, needsReanchor: true, confirmNotSent: l.confirmNotSent } : l));
    const onVis = () => document.visibilityState === "visible" && hidden();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", hidden);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", hidden);
    };
  }, [live?.swap.depositAddress, live]);

  const reanchor = useCallback(async () => {
    if (!live || unreadable) return;
    try {
      const chain = oc.chains.find((c) => c.id === live.swap.chainId)!;
      const { res, problem } = await quote({ chain, amount: BigInt(live.request.amount), recipient: live.request.recipient, refundTo: live.request.refundTo }, true);
      if (problem) return;
      const anchor = { responseTimestampMs: Date.parse(String(res.timestamp)), perfAtReceipt: performance.now(), dateAtReceipt: Date.now() };
      const pending = status === null || status.status === "PENDING_DEPOSIT" || status.status === "not-found";
      setLive((l) => (l ? { ...l, anchor, needsReanchor: false, confirmNotSent: pending } : l));
    } catch {
      // Leave the address hidden; the user can request a new quote once the old one is past its deadline.
    }
  }, [live, unreadable, oc.chains, quote, status]);

  const rem = live ? remainingMs(live.swap.deadlineMs, live.anchor, now.perf, now.date) : 0;
  const margin = live ? (oc.chains.find((c) => c.id === live.swap.chainId)?.marginMs ?? 0) : 0;
  const st = (status?.status ?? "not-found") as string;
  const known: SwapStatus = st === "PENDING_DEPOSIT" || st === "INCOMPLETE_DEPOSIT" || st === "not-found" || st === "unknown" ? st : "other";
  const view = live ? (live.confirmNotSent ? "hide" : addressView({ status: known, remainingMs: rem, marginMs: margin, needsReanchor: live.needsReanchor, reloaded: false })) : "hide";

  return { listSwaps: () => store.list(), nowMs: now.date, oc, client, swaps, save, tokens, down, quote, live, setLive, status, rem, margin, view, reanchor, chainIds: oc.chains.map((c) => c.id) as ChainId[] };
}
