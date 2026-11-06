import type { RpcClient } from "@/lib/chain/rpc";
import { findClaims } from "@/lib/vault/claims";
import { fixtureSnapshot } from "../fixtures/snapshot";

function rpcWithClaims(claims: Record<number, string>, buckets: Set<number>): RpcClient & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async view(_c, method, args, parse) {
      const n = (args as { nonce: number }).nonce;
      if (method === "bucket_claim") {
        asked.push(n);
        return { value: parse(claims[n] ?? "0"), blockHeight: 1n };
      }
      if (method === "bucket") return { value: parse(buckets.has(n) ? { token: "Wnear", result: "1", snapshot: "1", unclaimed: "1" } : null), blockHeight: 1n };
      throw new Error(method);
    },
    finalBlock: async () => ({ height: 1n, timestampSeconds: 1n }),
    viewAccount: async () => ({ value: { amount: 0n, storageUsage: 0n, codeHash: "" }, blockHeight: 1n }),
    accessKeyCount: async () => ({ value: 0, blockHeight: 1n }),
    gasPrice: async () => 1n,
  } as RpcClient & { asked: number[] };
}

test("claim scan covers 16 nonces and offers the next page", async () => {
  const s = await fixtureSnapshot({ lastNonce: 40n });
  const rpc = rpcWithClaims({ 30: "5" }, new Set([30]));
  const r = await findClaims(rpc, s, "a.near", 40n);
  expect(r).toEqual({ rows: [{ nonce: 30n, amount: 5n, resolved: true }], next: 24n });
  expect(rpc.asked).toHaveLength(16);
});
test("a claim on the swap that is still running is not resolved", async () => {
  const s = await fixtureSnapshot({ lastNonce: 9n, inflight: { nonce: 9n, tokenIn: "Usdc", tokenOut: "Wnear", amountIn: 1n, minAmountOut: 1n, amountOut: null, sharesSnapshot: 1n, sharesBurned: 1n, recovered: 0n, stuckSince: null } });
  const r = await findClaims(rpcWithClaims({ 9: "7" }, new Set([9])), s, "a.near", 9n);
  expect(r).toEqual({ rows: [{ nonce: 9n, amount: 7n, resolved: false }], next: null });
});
test("the scan stops at nonce 1", async () => {
  const s = await fixtureSnapshot({ lastNonce: 3n });
  const rpc = rpcWithClaims({}, new Set());
  expect(await findClaims(rpc, s, "a.near", 3n)).toEqual({ rows: [], next: null });
  expect(rpc.asked).toEqual([3, 2, 1]);
});
