"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Banner } from "@/components/fm/Banner";
import { config } from "@/config";
import { toJsonNonce } from "@/lib/chain/nonce";
import { createRpcClient } from "@/lib/chain/rpc";
import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { formatUnits, parseUnits } from "@/lib/format/units";
import { type BuildCtx, buildTx } from "@/lib/wallet/calls";
import type { Step, useTx } from "@/lib/wallet/useTx";
import { type ClaimRow, findClaims } from "@/lib/vault/claims";
import { canRedeem, redeemEstimate, redeemPrereqs } from "@/lib/vault/redeem";
import { CliCommand } from "./CliCommand";
import { NearNeed } from "./NearNeed";

type Run = ReturnType<typeof useTx>["run"];

function parseShares(text: string): bigint | null {
  try {
    return text.trim() ? parseUnits(text, 0) : null;
  } catch {
    return null;
  }
}

export function RedeemForm({ s, p, ctx, run, busy, unreadable, gasPrice = 0n }: { s: VaultSnapshot; p: Position; ctx: BuildCtx; run: Run; busy: boolean; unreadable: boolean; gasPrice?: bigint }) {
  const [text, setText] = useState("");
  const shares = text === "" ? p.shares : parseShares(text);
  const est = shares === null || shares > p.shares ? null : redeemEstimate(s.book, shares, s.totalShares);
  const prereqs = redeemPrereqs(p);
  const steps: Step[] = [...prereqs.map((name) => ({ name, args: {} })), { name: "redeem", args: { shares: (shares ?? 0n).toString() } }];
  const swapping = s.inflight !== null;
  return (
    <section aria-labelledby="redeem-title" className="grid gap-3 rounded-lg border p-5">
      <h2 id="redeem-title" className="text-lg font-semibold">Redeem</h2>
      {unreadable ? <Banner tone="warning" title="Data may be old">Redeem still works. The estimate may be out of date.</Banner> : null}
      <label className="grid gap-1">
        <span className="fm-label">Shares to redeem (all {p.shares.toString()} if empty)</span>
        <input inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} className="fm-input mono" />
      </label>
      <p className="mono text-[13px]" data-testid="redeem-estimate">
        {est ? `About ${formatUnits(est.usdc, s.assets.usdcDecimals, 2)} USDC and ${formatUnits(est.wnear, s.assets.wnearDecimals, 4)} wNEAR` : "Enter a share amount you hold."}
      </p>
      {swapping ? <p className="text-[13px]">A swap is running. Part of your payout becomes a claim you can take once it finishes.</p> : null}
      <NearNeed txs={steps.map((st) => buildTx(st.name, st.args, ctx))} near={p.balances.near} gasPrice={gasPrice} />
      {prereqs.length ? <p className="text-[13px]">Your account is first registered with the token contracts, so the payout cannot get stuck in claimable.</p> : null}
      <p className="text-[13px] text-muted-foreground">Redeem works while the vault is frozen, halted or stuck. It still depends on the USDC and wNEAR contracts. You receive USDC and wNEAR; unwrap wNEAR to NEAR in your wallet or with `near contract call-function as-transaction wrap.near near_withdraw`.</p>
      <button type="button" disabled={busy || !est || !canRedeem(est)} onClick={() => run(steps, () => (swapping ? "claim-pending" : undefined))} className="justify-self-start fm-btn fm-btn--outline disabled:opacity-50" data-variant="exit">
        Redeem
      </button>
      <CliCommand tx={buildTx("redeem", { shares: (shares ?? 0n).toString() }, ctx)} signer={p.account} network={config.network} />
    </section>
  );
}

export function Claims({ s, p, ctx, run, busy }: { s: VaultSnapshot; p: Position; ctx: BuildCtx; run: Run; busy: boolean }) {
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [next, setNext] = useState<bigint | null>(null);
  const [scanned, setScanned] = useState(false);
  // The scan reads the latest snapshot but re-runs only when the cycle count or the account changes,
  // so a 10 s refresh neither wipes claims loaded with "Search older" nor repeats 16 RPC calls.
  const latest = useRef(s);
  useEffect(() => {
    latest.current = s;
  }, [s]);
  const scan = useCallback(
    (from: bigint, append: boolean) =>
      findClaims(createRpcClient(config.rpcUrls), latest.current, p.account, from)
        .then((r) => {
          setRows((prev) => (append ? [...prev, ...r.rows] : r.rows));
          setNext(r.next);
        })
        .catch(() => setNext(null))
        .finally(() => setScanned(true)),
    [p.account],
  );
  const lastNonce = s.lastNonce;
  useEffect(() => {
    let alive = true;
    findClaims(createRpcClient(config.rpcUrls), latest.current, p.account, lastNonce)
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setNext(r.next);
      })
      .catch(() => alive && setNext(null))
      .finally(() => alive && setScanned(true));
    return () => {
      alive = false;
    };
  }, [lastNonce, p.account]);
  const tokens = [
    { token: "Usdc" as const, amount: p.claimable.usdc, label: "USDC", decimals: s.assets.usdcDecimals },
    { token: "Wnear" as const, amount: p.claimable.wnear, label: "wNEAR", decimals: s.assets.wnearDecimals },
  ].filter((t) => t.amount > 0n);
  return (
    <section aria-labelledby="claims-title" className="grid gap-3 rounded-lg border p-5">
      <h2 id="claims-title" className="text-lg font-semibold">Claims</h2>
      {rows.map((c) => {
        const nonce = toJsonNonce(c.nonce);
        return (
          <div key={c.nonce.toString()} className="flex flex-wrap items-center gap-3" data-claim-nonce={c.nonce.toString()}>
            <span className="mono">Cycle {c.nonce.toString()} · {c.amount.toString()} shares&apos; part</span>
            {c.resolved ? (
              nonce === null ? (
                <span className="text-[13px] text-danger">This cycle number is too large for this browser to claim exactly. Use the CLI.</span>
              ) : (
                <button type="button" disabled={busy} onClick={() => run([{ name: "claim_bucket", args: { nonce } }])} className="fm-btn fm-btn--outline">
                  Claim
                </button>
              )
            ) : (
              <span className="text-[13px] text-muted-foreground">Waiting for the swap to finish.</span>
            )}
          </div>
        );
      })}
      {tokens.map((t) => (
        <div key={t.token} className="flex flex-wrap items-center gap-3">
          <span className="mono">{formatUnits(t.amount, t.decimals, 4)} {t.label} claimable</span>
          <button type="button" disabled={busy} onClick={() => run([...redeemPrereqs(p).map((name) => ({ name, args: {} })), { name: "withdraw_claimable", args: { token: t.token } }])} className="fm-btn fm-btn--outline">
            Withdraw {t.label}
          </button>
        </div>
      ))}
      {scanned && rows.length === 0 && tokens.length === 0 ? <p className="text-muted-foreground">No claims in the last {16} cycles.</p> : null}
      {next !== null ? (
        <button type="button" onClick={() => void scan(next, true)} className="justify-self-start text-[13px] underline underline-offset-4">
          Search older cycles
        </button>
      ) : null}
      <p className="text-[13px] text-muted-foreground">Cancelling a deposit and withdrawing claimable emit no event, so the history page may not list them.</p>
      <CliCommand tx={buildTx("withdraw_claimable", { token: "Usdc" }, ctx)} signer={p.account} network={config.network} />
    </section>
  );
}

export function Exits(props: { s: VaultSnapshot; p: Position; ctx: BuildCtx; run: Run; busy: boolean; unreadable: boolean; gasPrice?: bigint }) {
  return (
    <>
      <RedeemForm {...props} />
      <Claims {...props} />
    </>
  );
}
