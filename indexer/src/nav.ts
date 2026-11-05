/** Raw NAV inputs at one block: `book`, `total_shares` and the oracle prices the vault itself would read. */
import { z } from "zod";
import { type ArchivalRpc, ContractError } from "./rpc";

const u128 = z.string().regex(/^\d+$/).transform(BigInt);
const bookSchema = z.object({ usdc: u128, wnear: u128 });
const oracleSchema = z.object({ account: z.string(), near_id: z.string(), usdc_id: z.string() });
const policySchema = z.object({ price_max_age: z.number().int().nonnegative() }).passthrough();
const feedSchema = z.object({ price: z.union([z.string(), z.number()]).transform((v) => BigInt(v)), expo: z.number().int() }).passthrough();
const feedsSchema = z.record(z.string(), feedSchema.nullable());

export interface NavRead {
  bookUsdc: bigint;
  bookWnear: bigint;
  totalShares: bigint;
  oracleNear: bigint | null;
  oracleUsdc: bigint | null;
}

/** Mirrors web/lib/chain/vault.ts `anchorFrom`: both feeds present, same exponent, positive. */
function anchor(raw: unknown, nearId: string, usdcId: string): { near: bigint; usdc: bigint } | null {
  const parsed = feedsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const near = parsed.data[nearId];
  const usdc = parsed.data[usdcId];
  if (!near || !usdc || near.expo !== usdc.expo || near.price <= 0n || usdc.price <= 0n) return null;
  return { near: near.price, usdc: usdc.price };
}

export async function readNav(rpc: Pick<ArchivalRpc, "viewAt">, vaultId: string, block: bigint): Promise<NavRead> {
  // One view at a time: old blocks fall through to archival nodes, which answer 429 to bursts.
  const book = bookSchema.parse(await rpc.viewAt<unknown>(block, vaultId, "book", {}));
  const totalShares = u128.parse(await rpc.viewAt<unknown>(block, vaultId, "total_shares", {}));
  const oracle = oracleSchema.parse(await rpc.viewAt<unknown>(block, vaultId, "oracle", {}));
  const policy = policySchema.parse(await rpc.viewAt<unknown>(block, vaultId, "policy", {}));
  let price: { near: bigint; usdc: bigint } | null = null;
  try {
    const raw = await rpc.viewAt<unknown>(block, oracle.account, "list_prices_no_older_than", { price_ids: [oracle.near_id, oracle.usdc_id], age: policy.price_max_age });
    price = anchor(raw, oracle.near_id, oracle.usdc_id);
  } catch (e) {
    // The oracle refusing the read (no fresh price at that block) is an answer: no price. An RPC outage is not.
    if (!(e instanceof ContractError)) throw e;
  }
  return { bookUsdc: book.usdc, bookWnear: book.wnear, totalShares, oracleNear: price?.near ?? null, oracleUsdc: price?.usdc ?? null };
}
