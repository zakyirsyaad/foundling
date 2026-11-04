import { z } from "zod";

import type { RpcClient } from "./rpc";
import {
  type Anchor,
  type Assets,
  type Book,
  type Position,
  type VaultSnapshot,
  agentSchema,
  assetsSchema,
  bookSchema,
  feedsSchema,
  oracleSchema,
  parseInflight,
  parsePolicy,
  parseStage,
  roleChangeSchema,
  rolesSchema,
  storageBalanceSchema,
  storageBoundsSchema,
  u128Schema,
  u64Schema,
} from "./types";

/** Shares per USDC base unit at the first deposit (`VIRTUAL_SHARES` in math.rs). */
export const SHARES_PER_UNIT = 1_000_000n;

const bool = (raw: unknown) => z.boolean().parse(raw);
const u128 = (raw: unknown) => u128Schema.parse(raw);
const u64 = (raw: unknown) => u64Schema.parse(raw);

/** Mirrors `read_anchor` without the clock checks: both feeds present, same exponent, positive. */
function anchorFrom(raw: unknown, nearId: string, usdcId: string): Anchor | null {
  const feeds = feedsSchema.parse(raw);
  const near = feeds[nearId];
  const usdc = feeds[usdcId];
  if (!near || !usdc || near.expo !== usdc.expo || near.price <= 0n || usdc.price <= 0n) return null;
  return { near: near.price, usdc: usdc.price };
}

export async function readVaultSnapshot(rpc: RpcClient, vaultId: string, now: () => number = Date.now): Promise<VaultSnapshot> {
  const v = <T>(method: string, parse: (raw: unknown) => T, args: object = {}) => rpc.view(vaultId, method, args, parse).then((r) => r.value);
  const [block, stage, inflight, policy, assets, roles, book, totalShares, lastNonce, opsSpent, usedUsdc, usedWnear, frozen, halted, setupDone, selftestPassed, storageMin, agent, revealed, keeperChange, guardianChange, oracle, account, accessKeys] =
    await Promise.all([
      rpc.finalBlock(),
      v("stage", parseStage),
      v("inflight", parseInflight),
      v("policy", parsePolicy),
      v("assets", (r) => assetsSchema.parse(r)),
      v("roles", (r) => rolesSchema.parse(r)),
      v("book", (r) => bookSchema.parse(r)),
      v("total_shares", u128),
      v("last_nonce", u64),
      v("ops_spent", u128),
      v("window_used", u128, { token_in: "Usdc" }),
      v("window_used", u128, { token_in: "Wnear" }),
      v("is_frozen", bool),
      v("is_halted", bool),
      v("is_setup_done", bool),
      v("selftest_passed", bool),
      v("storage_balance_bounds", (r) => storageBoundsSchema.parse(r)),
      v("agent", (r) => agentSchema.parse(r)),
      v("revealed", (r) => z.string().nullable().parse(r) !== null),
      v("keeper_change", (r) => roleChangeSchema.parse(r)),
      v("guardian_change", (r) => roleChangeSchema.parse(r)),
      v("oracle", (r) => oracleSchema.parse(r)),
      rpc.viewAccount(vaultId).then((r) => r.value),
      rpc.accessKeyCount(vaultId).then((r) => r.value),
    ]);
  const bounds = (token: string) => rpc.view(token, "storage_balance_bounds", {}, (r) => storageBoundsSchema.parse(r)).then((r) => r.value);
  const [usdcMin, wnearMin, price] = await Promise.all([
    bounds(assets.usdc),
    bounds(assets.wnear),
    rpc
      .view(oracle.account, "list_prices_no_older_than", { price_ids: [oracle.nearId, oracle.usdcId], age: Number(policy.priceMaxAge) }, (r) => anchorFrom(r, oracle.nearId, oracle.usdcId))
      .then((r) => r.value),
  ]);
  return {
    vaultId,
    blockHeight: block.height,
    chainTimeSeconds: block.timestampSeconds,
    fetchedAtMs: now(),
    stage, inflight, policy, assets, roles, book, totalShares, lastNonce, opsSpent,
    windowUsed: { usdc: usedUsdc, wnear: usedWnear },
    frozen, halted, setupDone, selftestPassed, accessKeys, account, storageMin,
    tokenStorageMin: { usdc: usdcMin, wnear: wnearMin },
    agent, revealed, keeperChange, guardianChange, price,
  };
}

export async function readPosition(rpc: RpcClient, s: VaultSnapshot, account: string, usdcE: string | null): Promise<Position> {
  const v = <T>(contract: string, method: string, parse: (raw: unknown) => T, args: object = {}) => rpc.view(contract, method, args, parse).then((r) => r.value);
  const registered = (contract: string) => v(contract, "storage_balance_of", (r) => storageBalanceSchema.parse(r) !== null, { account_id: account });
  const [shares, pending, netDeposit, claimUsdc, claimWnear, regVault, regUsdc, regWnear, usdcBalance, usdcEBalance, allowed, near] = await Promise.all([
    v(s.vaultId, "shares_of", u128, { account }),
    v(s.vaultId, "pending_of", u128, { account }),
    v(s.vaultId, "net_deposit_of", u128, { account }),
    v(s.vaultId, "claimable_of", u128, { account, token: "Usdc" }),
    v(s.vaultId, "claimable_of", u128, { account, token: "Wnear" }),
    registered(s.vaultId),
    registered(s.assets.usdc),
    registered(s.assets.wnear),
    v(s.assets.usdc, "ft_balance_of", u128, { account_id: account }),
    usdcE ? v(usdcE, "ft_balance_of", u128, { account_id: account }) : Promise.resolve(0n),
    v(s.vaultId, "is_allowed", bool, { account }),
    rpc.viewAccount(account).then((r) => r.value.amount),
  ]);
  return {
    account, shares, pending, netDeposit,
    claimable: { usdc: claimUsdc, wnear: claimWnear },
    registered: { vault: regVault, usdc: regUsdc, wnear: regWnear },
    balances: { usdc: usdcBalance, usdcE: usdcEBalance, near },
    allowed,
  };
}

/** Never let an answer from an older block replace what is already on screen. */
export function acceptSnapshot(prev: VaultSnapshot | null, next: VaultSnapshot): VaultSnapshot {
  return prev && prev.blockHeight > next.blockHeight ? prev : next;
}

/** Book value in USDC base units: `usdc + wnear·near/usdc/10^(wnearDecimals−usdcDecimals)`. Null without a price. */
export function navUsdc(book: Book, price: Anchor | null, assets: Assets): bigint | null {
  if (book.wnear === 0n) return book.usdc;
  if (!price) return null;
  const scale = 10n ** BigInt(assets.wnearDecimals - assets.usdcDecimals);
  return book.usdc + (book.wnear * price.near) / price.usdc / scale;
}

/**
 * USDC base units for the shares one whole USDC minted at the start, so the first price is
 * exactly 1 USDC: `nav · 10^usdcDecimals · SHARES_PER_UNIT / totalShares`.
 */
export function sharePrice(nav: bigint | null, totalShares: bigint, usdcDecimals: number): bigint | null {
  if (nav === null || totalShares === 0n) return null;
  return (nav * 10n ** BigInt(usdcDecimals) * SHARES_PER_UNIT) / totalShares;
}
