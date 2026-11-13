"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { config } from "@/config";
import { createRpcClient } from "./rpc";
import type { Position, VaultSnapshot } from "./types";
import { readPosition } from "./vault";

const DEFAULT_GAS_PRICE = 100_000_000n;

/**
 * When to read again. "snapshot": on every new vault snapshot, so wallet balances stay current
 * (Portfolio). "change": only when a cycle settled, the stage moved or total shares moved, which
 * is all that can change shares and the queue without the visitor acting (Overview).
 */
export type PositionRefresh = "snapshot" | "change";

/** What a position can depend on in the vault, short of the visitor's own transactions. */
export function positionKey(s: VaultSnapshot): string {
  return `${s.vaultId}:${s.lastNonce}:${s.stage.kind}:${s.totalShares}`;
}

/** The connected account's position and the current gas price, read from RPC only. */
export function usePosition(account: string | null, s: VaultSnapshot | null, { refresh = "snapshot" }: { refresh?: PositionRefresh } = {}) {
  const [read, setRead] = useState<{ account: string; position: Position | null }>({ account: "", position: null });
  const [gasPrice, setGasPrice] = useState<bigint>(DEFAULT_GAS_PRICE);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // The read below uses the newest snapshot without re-running for each one.
  const latest = useRef(s);
  useEffect(() => {
    latest.current = s;
  });
  const trigger = s === null ? null : refresh === "snapshot" ? s : positionKey(s);
  useEffect(() => {
    const snap = latest.current;
    if (!account || !snap || trigger === null) return;
    let alive = true;
    const rpc = createRpcClient(config.rpcUrls);
    Promise.all([readPosition(rpc, snap, account, config.usdcE), rpc.gasPrice()])
      .then(([position, g]) => {
        if (!alive) return;
        setRead({ account, position });
        setGasPrice(g);
      })
      .catch(() => {
        if (alive) setRead({ account, position: null });
      });
    return () => {
      alive = false;
    };
  }, [account, trigger, tick]);
  // A position read for another account is never shown for this one.
  const position = account && s && read.account === account ? read.position : null;
  return { position, gasPrice, reload };
}
