import type { RpcClient } from "@/lib/chain/rpc";
import { fallbackCycles } from "@/lib/cycles/fallback";

function rpc(decisions: Record<number, string | null>): RpcClient & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async view(_c, method, args, parse) {
      if (method !== "published_decision") throw new Error(method);
      const n = (args as { nonce: number }).nonce;
      asked.push(n);
      return { value: parse(decisions[n] ?? null), blockHeight: 1n };
    },
    finalBlock: async () => ({ height: 1n, timestampSeconds: 1n }),
    viewAccount: async () => ({ value: { amount: 0n, storageUsage: 0n, codeHash: "" }, blockHeight: 1n }),
    accessKeyCount: async () => ({ value: 0, blockHeight: 1n }),
    gasPrice: async () => 1n,
  } as RpcClient & { asked: number[] };
}

test("reads the last decisions newest first and labels the result partial", async () => {
  const r = rpc({ 41: '{"action":"buy"}', 40: null });
  const out = await fallbackCycles(r, "vault.near", 41n, 3);
  expect(out).toEqual({ partial: true, rows: [{ nonce: 41n, decision: '{"action":"buy"}' }, { nonce: 40n, decision: null }, { nonce: 39n, decision: null }] });
  expect(r.asked).toEqual([41, 40, 39]);
});
test("never asks past nonce 1 or the 64 the contract keeps", async () => {
  expect((await fallbackCycles(rpc({}), "vault.near", 2n, 20)).rows.map((x) => x.nonce)).toEqual([2n, 1n]);
  expect((await fallbackCycles(rpc({}), "vault.near", 500n, 100)).rows).toHaveLength(64);
  expect((await fallbackCycles(rpc({}), "vault.near", 0n)).rows).toEqual([]);
});
