"use client";

import Link from "next/link";
import { useState } from "react";

import type { Network } from "@/config/deployment";
import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { formatUnits, parseUnits } from "@/lib/format/units";
import { type BuildCtx, buildTx } from "@/lib/wallet/calls";
import type { Step } from "@/lib/wallet/useTx";
import { GATE_TEXT, type GateReason, depositChecks } from "@/lib/vault/deposit";
import { CliCommand } from "./CliCommand";

const NEAR = 24;

function parseAmount(text: string, decimals: number): bigint | null {
  try {
    return text.trim() ? parseUnits(text, decimals) : null;
  } catch {
    return null;
  }
}

export function DepositForm({ s, p, gasPrice, reasons, ctx, network, busy, onSubmit }: { s: VaultSnapshot; p: Position; gasPrice: bigint; reasons: GateReason[]; ctx: BuildCtx; network: Network; busy: boolean; onSubmit: (steps: Step[]) => void }) {
  const [text, setText] = useState("");
  const d = s.assets.usdcDecimals;
  if (reasons.length) {
    return (
      <section aria-labelledby="deposit-title" className="grid gap-3 rounded-lg border p-5">
        <h2 id="deposit-title" className="text-lg font-semibold">Deposit</h2>
        {reasons.map((r) => (
          <p key={r}>{GATE_TEXT[r]}</p>
        ))}
      </section>
    );
  }
  const amount = parseAmount(text, d);
  const checks = amount === null ? null : depositChecks(amount, s, p, gasPrice);
  const steps: Step[] = [...(p.registered.vault ? [] : [{ name: "register_vault" as const, args: {} }]), { name: "deposit", args: { amount: (amount ?? 0n).toString() } }];
  const disabled = busy || amount === null || amount === 0n || !checks || checks.belowMin || checks.overUserCap || checks.overBalance;
  return (
    <section aria-labelledby="deposit-title" className="grid gap-3 rounded-lg border p-5">
      <h2 id="deposit-title" className="text-lg font-semibold">Deposit</h2>
      <label className="grid gap-1">
        <span className="fm-label">Amount in USDC</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} className="fm-input mono" aria-describedby="deposit-help" />
      </label>
      <div id="deposit-help" className="grid gap-1 text-[13px] text-muted-foreground">
        <p>Token: <span className="mono">{s.assets.usdc}</span>. Balance {formatUnits(p.balances.usdc, d, 2)} USDC.</p>
        {p.balances.usdcE > 0n && p.balances.usdc === 0n ? <p>This account holds only bridged USDC.e. The vault takes native USDC only.</p> : null}
        <p>You can still add {formatUnits(checks?.remainingUserCap ?? (s.policy.perUserCap > p.netDeposit ? s.policy.perUserCap - p.netDeposit : 0n), d, 2)} USDC. Minimum {formatUnits(s.policy.minDeposit, d, 2)} USDC.</p>
        <p>The vault has room for about {formatUnits(checks?.tvlRemainingEstimate ?? 0n, d, 2)} USDC more. This is an estimate; if the vault is full, the deposit is refunded in full.</p>
        {p.registered.vault ? null : <p>First deposit: a one-time, non-refundable registration of {formatUnits(s.storageMin, NEAR, 4)} NEAR.</p>}
        {checks && checks.nearShortfall > 0n ? <p data-testid="near-shortfall">You need {formatUnits(checks.nearShortfall, NEAR, 5)} more NEAR for this.</p> : null}
        {checks?.belowMin ? <p>That is below the minimum deposit.</p> : null}
        {checks?.overUserCap ? <p>That is over what this account can still add.</p> : null}
        {checks?.overBalance ? <p>That is more than this account holds.</p> : null}
        <p>Shares mint at the next cycle, when the vault holds only USDC, so a wrong price cannot dilute holders.</p>
      </div>
      <p className="text-[13px] font-medium">
        Not audited. You can lose money. <Link href="/trust" className="underline underline-offset-4">Read the risks</Link>
      </p>
      <button type="button" disabled={disabled} onClick={() => onSubmit(steps)} className="justify-self-start fm-btn fm-btn--primary">
        Deposit
      </button>
      <CliCommand tx={buildTx("deposit", { amount: (amount ?? 0n).toString() }, ctx)} signer={p.account} network={network} />
    </section>
  );
}
