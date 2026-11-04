"use client";

import { CopyButton } from "@/components/fm/CopyButton";
import { config } from "@/config";
import type { VaultSnapshot } from "@/lib/chain/types";
import { CALLS, type CallName, DEFAULT_GAS_TGAS, GAS_MARGIN_TGAS } from "@/lib/wallet/calls";
import { cliCommand } from "@/lib/wallet/cli";
import type { Step } from "@/lib/wallet/useTx";
import { recoveryAction } from "@/lib/vault/recovery";

/** A transaction can land a few blocks after it is signed, so warn this long before the halt clock runs out. */
export const HALT_MARGIN_SECONDS = 30n;
const TGAS = 10n ** 12n;

export function haltWarning(haltAt: bigint | null, freshChainTime: bigint, marginSeconds = HALT_MARGIN_SECONDS): boolean {
  return haltAt !== null && freshChainTime + marginSeconds >= haltAt;
}

function cli(s: VaultSnapshot, name: CallName, args: object): string {
  const gas = BigInt((CALLS[name].minGasTgas ?? DEFAULT_GAS_TGAS) + GAS_MARGIN_TGAS) * TGAS;
  return cliCommand({ receiverId: s.vaultId, methodName: CALLS[name].method, args, gas, deposit: 0n }, null, config.network);
}

/** "Vault stuck" panel, RPC only (WEBSITE §3 Pemulihan). Shared by /app and /app/portfolio. */
export function StuckPanel({ s, fresh, run, busy, canSign }: { s: VaultSnapshot; fresh: boolean; run: (steps: Step[]) => void; busy: boolean; canSign: boolean }) {
  const a = recoveryAction(s.stage, s.inflight, s.policy, s.chainTimeSeconds, s.blockHeight);
  if (!a.advance && !a.abortStale && !a.expireDecision) return null;
  const nonce = "nonce" in s.stage ? Number(s.stage.nonce) : 0;
  const disabled = busy || !fresh || !canSign;
  const action: { name: CallName; label: string; args: object } = a.advance
    ? { name: "advance", label: `Advance cycle ${nonce}`, args: { nonce } }
    : a.abortStale
      ? { name: "abort_stale_cycle", label: "Abort stale cycle", args: {} }
      : { name: "expire_decision", label: "Expire decision", args: {} };
  const cmd = cli(s, action.name, action.args);
  return (
    <section aria-labelledby="stuck-title" className="grid gap-3 rounded-lg border border-warning bg-warning-bg p-5" data-testid="stuck-panel">
      <h2 id="stuck-title" className="text-lg font-semibold">{a.advance ? "Vault stuck" : "Cycle can be cleared"}</h2>
      {a.advance ? (
        <>
          <p>A swap step got no answer. Anyone can advance it; claims on this swap wait for it to finish.</p>
          <p>One advance does not promise the claim opens: the step may go back to Stuck and need another try.</p>
          {haltWarning(a.haltAt, s.chainTimeSeconds) ? (
            <p role="alert" className="font-medium">The halt clock has almost run out. Advancing now may halt the vault, and only the governor can clear a halt. Redeem stays open either way.</p>
          ) : null}
        </>
      ) : (
        <p>{a.abortStale ? "The cycle waited too long for its decision or price. Clearing it unlocks nobody's funds; it only lets the next cycle start." : "The decision expired before it ran. Expiring it lets the next cycle start."}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={disabled} data-variant={a.advance ? "primary" : "plain"} onClick={() => run([{ name: action.name, args: action.args }])} className={a.advance ? "rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50" : "rounded-md border border-input px-4 py-2 disabled:opacity-50"}>
          {action.label}
        </button>
        {!fresh ? <span className="text-[13px]">Waiting for a fresh read</span> : null}
      </div>
      <div className="fm-code">
        <code className="break-all">{cmd}</code>
        <CopyButton text={cmd} label="Copy command" />
      </div>
    </section>
  );
}
