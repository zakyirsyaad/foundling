import { z } from "zod";

import { parseU128 } from "@/lib/format/units";
import type { AccountInfo } from "./rpc";

export type Token = "Usdc" | "Wnear";
export type SwapStep = "Deposit" | "Swap" | "Withdraw";
export type Stage =
  | { kind: "Idle" }
  | { kind: "AwaitingDecision"; nonce: bigint; enteredBlock: bigint }
  | { kind: "DecisionReady"; nonce: bigint; expiresAt: bigint }
  | { kind: "AwaitingPrice"; nonce: bigint; enteredBlock: bigint; expiresAt: bigint }
  | { kind: "Depositing" | "Swapping"; nonce: bigint; attempt: number; enteredAt: bigint }
  | { kind: "Withdrawing"; nonce: bigint; attempt: number; enteredAt: bigint; unwinding: boolean; token: Token; amount: bigint }
  | { kind: "Stuck"; nonce: bigint; step: SwapStep; attempt: number; since: bigint }
  | { kind: "Probing"; nonce: bigint; step: SwapStep; attempt: number; stuckSince: bigint; enteredAt: bigint };

export interface Inflight {
  nonce: bigint;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  minAmountOut: bigint;
  amountOut: bigint | null;
  sharesSnapshot: bigint;
  sharesBurned: bigint;
  recovered: bigint;
  stuckSince: bigint | null;
}

export interface Policy {
  capBps: number;
  epochCapBps: number;
  capUsdc: bigint;
  epochCapUsdc: bigint;
  capWnear: bigint;
  epochCapWnear: bigint;
  capSellBps: number;
  dustWnear: bigint;
  maxRiskBps: number;
  epochLen: bigint;
  cooldown: bigint;
  slippageBps: number;
  priceMaxAge: bigint;
  priceMaxConfBps: number;
  refDevBps: number;
  decisionTtl: bigint;
  abortAfterBlocks: bigint;
  stuckAfter: bigint;
  haltAfter: bigint;
  maxExecutionSeconds: bigint;
  opsBudget: bigint;
  nearReserve: bigint;
  tvlCap: bigint;
  perUserCap: bigint;
  minDeposit: bigint;
  maxMintPerCycle: number;
  timelock: bigint;
  openDeposits: boolean;
}

export interface Assets {
  usdc: string;
  wnear: string;
  rhea: string;
  poolId: bigint;
  poolFeeBps: number;
  usdcDecimals: number;
  wnearDecimals: number;
}
export interface Roles {
  governor: string;
  keeper: string;
  guardian: string;
}
export interface RoleChange {
  account: string;
  applyAfter: bigint;
}
export interface Book {
  usdc: bigint;
  wnear: bigint;
}
export interface Anchor {
  near: bigint;
  usdc: bigint;
}
export interface OracleConfig {
  account: string;
  nearId: string;
  usdcId: string;
}

export interface VaultSnapshot {
  vaultId: string;
  blockHeight: bigint;
  chainTimeSeconds: bigint;
  fetchedAtMs: number;
  stage: Stage;
  inflight: Inflight | null;
  policy: Policy;
  assets: Assets;
  roles: Roles;
  book: Book;
  totalShares: bigint;
  lastNonce: bigint;
  opsSpent: bigint;
  windowUsed: { usdc: bigint; wnear: bigint };
  frozen: boolean;
  halted: boolean;
  setupDone: boolean;
  selftestPassed: boolean;
  accessKeys: number;
  account: AccountInfo;
  storageMin: bigint;
  tokenStorageMin: { usdc: bigint; wnear: bigint };
  agent: { wasmHash: string; wasmUrl: string; commitment: string; revealAfter: bigint };
  revealed: boolean;
  keeperChange: RoleChange | null;
  guardianChange: RoleChange | null;
  price: Anchor | null;
}

export interface Position {
  account: string;
  shares: bigint;
  pending: bigint;
  netDeposit: bigint;
  claimable: { usdc: bigint; wnear: bigint };
  registered: { vault: boolean; usdc: boolean; wnear: boolean };
  balances: { usdc: bigint; usdcE: bigint; near: bigint };
  allowed: boolean;
}

const u128 = z.string().transform((s) => parseU128(s));
const u64 = z.number().int().nonnegative().refine(Number.isSafeInteger, "u64 above 2^53 - 1 cannot be represented exactly").transform((n) => BigInt(n));
const u32 = z.number().int().nonnegative();
const token = z.enum(["Usdc", "Wnear"]);
const step = z.enum(["Deposit", "Swap", "Withdraw"]);

const stageVariants = {
  AwaitingDecision: z.object({ nonce: u64, entered_block: u64 }).transform((v) => ({ kind: "AwaitingDecision" as const, nonce: v.nonce, enteredBlock: v.entered_block })),
  DecisionReady: z.object({ nonce: u64, expires_at: u64 }).transform((v) => ({ kind: "DecisionReady" as const, nonce: v.nonce, expiresAt: v.expires_at })),
  AwaitingPrice: z.object({ nonce: u64, entered_block: u64, expires_at: u64 }).transform((v) => ({ kind: "AwaitingPrice" as const, nonce: v.nonce, enteredBlock: v.entered_block, expiresAt: v.expires_at })),
  Depositing: z.object({ nonce: u64, attempt: u32, entered_at: u64 }).transform((v) => ({ kind: "Depositing" as const, nonce: v.nonce, attempt: v.attempt, enteredAt: v.entered_at })),
  Swapping: z.object({ nonce: u64, attempt: u32, entered_at: u64 }).transform((v) => ({ kind: "Swapping" as const, nonce: v.nonce, attempt: v.attempt, enteredAt: v.entered_at })),
  Withdrawing: z
    .object({ nonce: u64, attempt: u32, entered_at: u64, unwinding: z.boolean(), token, amount: u128 })
    .transform((v) => ({ kind: "Withdrawing" as const, nonce: v.nonce, attempt: v.attempt, enteredAt: v.entered_at, unwinding: v.unwinding, token: v.token, amount: v.amount })),
  Stuck: z.object({ nonce: u64, step, attempt: u32, since: u64 }).transform((v) => ({ kind: "Stuck" as const, nonce: v.nonce, step: v.step, attempt: v.attempt, since: v.since })),
  Probing: z
    .object({ nonce: u64, step, attempt: u32, stuck_since: u64, entered_at: u64 })
    .transform((v) => ({ kind: "Probing" as const, nonce: v.nonce, step: v.step, attempt: v.attempt, stuckSince: v.stuck_since, enteredAt: v.entered_at })),
} as const;

/** Serde's external tagging: `"Idle"` for the unit variant, `{"Variant": {...}}` for the others. */
export function parseStage(raw: unknown): Stage {
  if (raw === "Idle") return { kind: "Idle" };
  if (typeof raw !== "object" || raw === null) throw new Error(`unknown stage: ${JSON.stringify(raw)}`);
  const entries = Object.entries(raw);
  const [name, body] = entries[0] ?? [];
  if (entries.length !== 1 || !name || !(name in stageVariants)) throw new Error(`unknown stage: ${JSON.stringify(raw)}`);
  return stageVariants[name as keyof typeof stageVariants].parse(body);
}

const policySchema = z
  .object({
    cap_bps: u32, epoch_cap_bps: u32, cap_usdc: u128, epoch_cap_usdc: u128, cap_wnear: u128, epoch_cap_wnear: u128,
    cap_sell_bps: u32, dust_wnear: u128, max_risk_bps: u32, epoch_len: u64, cooldown: u64, slippage_bps: u32,
    price_max_age: u64, price_max_conf_bps: u32, ref_dev_bps: u32, decision_ttl: u64, abort_after_blocks: u64,
    stuck_after: u64, halt_after: u64, max_execution_seconds: u64, ops_budget: u128, near_reserve: u128,
    tvl_cap: u128, per_user_cap: u128, min_deposit: u128, max_mint_per_cycle: u32, timelock: u64,
    open_deposits: z.boolean().optional(),
  })
  .transform(
    (p): Policy => ({
      capBps: p.cap_bps, epochCapBps: p.epoch_cap_bps, capUsdc: p.cap_usdc, epochCapUsdc: p.epoch_cap_usdc,
      capWnear: p.cap_wnear, epochCapWnear: p.epoch_cap_wnear, capSellBps: p.cap_sell_bps, dustWnear: p.dust_wnear,
      maxRiskBps: p.max_risk_bps, epochLen: p.epoch_len, cooldown: p.cooldown, slippageBps: p.slippage_bps,
      priceMaxAge: p.price_max_age, priceMaxConfBps: p.price_max_conf_bps, refDevBps: p.ref_dev_bps,
      decisionTtl: p.decision_ttl, abortAfterBlocks: p.abort_after_blocks, stuckAfter: p.stuck_after,
      haltAfter: p.halt_after, maxExecutionSeconds: p.max_execution_seconds, opsBudget: p.ops_budget,
      nearReserve: p.near_reserve, tvlCap: p.tvl_cap, perUserCap: p.per_user_cap, minDeposit: p.min_deposit,
      maxMintPerCycle: p.max_mint_per_cycle, timelock: p.timelock, openDeposits: p.open_deposits ?? false,
    }),
  );

export function parsePolicy(raw: unknown): Policy {
  return policySchema.parse(raw);
}

const inflightSchema = z
  .object({
    nonce: u64, token_in: token, token_out: token, amount_in: u128, min_amount_out: u128, amount_out: u128.nullable(),
    shares_snapshot: u128, shares_burned: u128, recovered: u128, stuck_since: u64.nullable(),
  })
  .transform(
    (v): Inflight => ({
      nonce: v.nonce, tokenIn: v.token_in, tokenOut: v.token_out, amountIn: v.amount_in, minAmountOut: v.min_amount_out,
      amountOut: v.amount_out, sharesSnapshot: v.shares_snapshot, sharesBurned: v.shares_burned, recovered: v.recovered,
      stuckSince: v.stuck_since,
    }),
  );

export function parseInflight(raw: unknown): Inflight | null {
  return raw === null ? null : inflightSchema.parse(raw);
}

export const assetsSchema = z
  .object({ usdc: z.string(), wnear: z.string(), rhea: z.string(), pool_id: u64, pool_fee_bps: u32, usdc_decimals: u32, wnear_decimals: u32 })
  .transform((a): Assets => ({ usdc: a.usdc, wnear: a.wnear, rhea: a.rhea, poolId: a.pool_id, poolFeeBps: a.pool_fee_bps, usdcDecimals: a.usdc_decimals, wnearDecimals: a.wnear_decimals }));
export const rolesSchema = z.object({ governor: z.string(), keeper: z.string(), guardian: z.string() });
export const roleChangeSchema = z
  .object({ account: z.string(), apply_after: u64 })
  .nullable()
  .transform((r): RoleChange | null => (r ? { account: r.account, applyAfter: r.apply_after } : null));
export const bookSchema = z.object({ usdc: u128, wnear: u128 });
export const oracleSchema = z
  .object({ account: z.string(), near_id: z.string(), usdc_id: z.string() })
  .transform((o): OracleConfig => ({ account: o.account, nearId: o.near_id, usdcId: o.usdc_id }));
export const agentSchema = z
  .object({ wasm_hash: z.string(), wasm_url: z.string(), commitment: z.string(), reveal_after: u64 })
  .loose()
  .transform((a) => ({ wasmHash: a.wasm_hash, wasmUrl: a.wasm_url, commitment: a.commitment, revealAfter: a.reveal_after }));
export const storageBoundsSchema = z.object({ min: u128 }).loose().transform((b) => b.min);
export const storageBalanceSchema = z.object({ total: u128 }).loose().nullable();
const feedSchema = z.object({ price: u128, expo: z.number().int() }).loose().nullable();
export const feedsSchema = z.record(z.string(), feedSchema);
export const u128Schema = u128;
export const u64Schema = u64;
