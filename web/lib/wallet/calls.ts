import type { DeploymentConfig } from "@/config/deployment";
import type { Assets } from "@/lib/chain/types";

export type CallName =
  | "redeem" | "cancel_deposit" | "claim_bucket" | "withdraw_claimable"
  | "advance" | "abort_stale_cycle" | "expire_decision"
  | "deposit" | "register_vault" | "register_usdc" | "register_wnear";

export interface CallSpec {
  receiver: "vault" | "usdc" | "wnear";
  method: string;
  /** The contract's minimum prepaid gas, or null where it has none. */
  minGasTgas: number | null;
  deposit: "one_yocto" | "none" | "storage_min";
}

/**
 * The wallet call table (WEBSITE §4). The only receiver and method pairs the website will ask a
 * wallet to sign. `check:contract` keeps the minimums in step with the Rust source.
 * `deposit` and `register_*` gas are first estimates, measured on testnet in W5.
 */
export const CALLS: Readonly<Record<CallName, CallSpec>> = Object.freeze({
  redeem: { receiver: "vault", method: "redeem", minGasTgas: 95, deposit: "one_yocto" },
  cancel_deposit: { receiver: "vault", method: "cancel_deposit", minGasTgas: 55, deposit: "one_yocto" },
  claim_bucket: { receiver: "vault", method: "claim_bucket", minGasTgas: 55, deposit: "one_yocto" },
  withdraw_claimable: { receiver: "vault", method: "withdraw_claimable", minGasTgas: 55, deposit: "one_yocto" },
  advance: { receiver: "vault", method: "advance", minGasTgas: 110, deposit: "none" },
  abort_stale_cycle: { receiver: "vault", method: "abort_stale_cycle", minGasTgas: null, deposit: "none" },
  expire_decision: { receiver: "vault", method: "expire_decision", minGasTgas: null, deposit: "none" },
  deposit: { receiver: "usdc", method: "ft_transfer_call", minGasTgas: 100, deposit: "one_yocto" },
  register_vault: { receiver: "vault", method: "storage_deposit", minGasTgas: 30, deposit: "storage_min" },
  register_usdc: { receiver: "usdc", method: "storage_deposit", minGasTgas: 30, deposit: "storage_min" },
  register_wnear: { receiver: "wnear", method: "storage_deposit", minGasTgas: 30, deposit: "storage_min" },
});

export const GAS_MARGIN_TGAS = 20;
export const DEFAULT_GAS_TGAS = 30;
export const MAX_GAS_TGAS = 300;
const TGAS = 10n ** 12n;

export interface WalletTx {
  receiverId: string;
  methodName: string;
  args: object;
  gas: bigint;
  deposit: bigint;
}
export interface BuildCtx {
  config: DeploymentConfig;
  assets: Assets;
  storageMin: { vault: bigint; usdc: bigint; wnear: bigint };
}

/** Prepaid gas for a call: its minimum (or the default) plus the margin, capped at the protocol limit. */
export function gasFor(name: CallName): bigint {
  const tgas = Math.min((CALLS[name].minGasTgas ?? DEFAULT_GAS_TGAS) + GAS_MARGIN_TGAS, MAX_GAS_TGAS);
  return BigInt(tgas) * TGAS;
}

/** Builds one call from the table. Refuses when the pinned token ids differ from what the vault reports. */
export function buildTx(name: CallName, args: object, ctx: BuildCtx): WalletTx {
  const spec = CALLS[name];
  if (ctx.assets.usdc !== ctx.config.usdc) throw new Error(`USDC mismatch: the vault uses ${ctx.assets.usdc}, this site pins ${ctx.config.usdc}`);
  if (ctx.assets.wnear !== ctx.config.wnear) throw new Error(`wNEAR mismatch: the vault uses ${ctx.assets.wnear}, this site pins ${ctx.config.wnear}`);
  const receiverId = spec.receiver === "vault" ? ctx.config.vaultId : spec.receiver === "usdc" ? ctx.config.usdc : ctx.config.wnear;
  const deposit = spec.deposit === "one_yocto" ? 1n : spec.deposit === "none" ? 0n : ctx.storageMin[spec.receiver];
  const fullArgs = name === "deposit" ? { receiver_id: ctx.config.vaultId, amount: (args as { amount: string }).amount, msg: "deposit" } : args;
  return { receiverId, methodName: spec.method, args: fullArgs, gas: gasFor(name), deposit };
}
