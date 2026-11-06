import type { RpcClient } from "@/lib/chain/rpc";
import { acceptSnapshot, navUsdc, readPosition, readVaultSnapshot, sharePrice } from "@/lib/chain/vault";
import type { Assets, VaultSnapshot } from "@/lib/chain/types";
import { vaultViews } from "../fixtures/vault";

function fakeRpc(views: Record<string, unknown>, perAccount: Record<string, Record<string, unknown>> = {}) {
  const rpc = {
    calls: 0,
    async view<T>(contract: string, method: string, _args: object, parse: (raw: unknown) => T) {
      rpc.calls++;
      const table = perAccount[contract] ?? views;
      if (!(method in table)) throw new Error(`no fixture for ${contract}.${method}`);
      return { value: parse(table[method]), blockHeight: 200n };
    },
    async finalBlock() { rpc.calls++; return { height: 201n, timestampSeconds: 1800000000n }; },
    async viewAccount() { rpc.calls++; return { value: { amount: 10n ** 25n, storageUsage: 1000n, codeHash: "CodeHash" }, blockHeight: 200n }; },
    async accessKeyCount() { rpc.calls++; return { value: 0, blockHeight: 200n }; },
    async gasPrice() { return 100_000_000n; },
  };
  return rpc as RpcClient & { calls: number };
}

const baseAssets: Assets = { usdc: "u", wnear: "w", rhea: "r", poolId: 1n, poolFeeBps: 1, usdcDecimals: 6, wnearDecimals: 24 };

test("values a wNEAR book at the oracle price", () => {
  expect(navUsdc({ usdc: 0n, wnear: 10n ** 24n }, { near: 250_000_000n, usdc: 100_000_000n }, baseAssets)).toBe(2_500_000n);
  expect(navUsdc({ usdc: 5n, wnear: 0n }, null, baseAssets)).toBe(5n);
  expect(navUsdc({ usdc: 1n, wnear: 1n }, null, baseAssets)).toBeNull();
});
test("the first share price is exactly 1 USDC", () => {
  // 1 USDC (10^6 base units) mints 10^12 shares, so a share price of 1 USDC is 1_000_000 base units.
  expect(sharePrice(1_000_000n, 10n ** 12n, 6)).toBe(1_000_000n);
  expect(sharePrice(1_004_200n, 10n ** 12n, 6)).toBe(1_004_200n);
  expect(sharePrice(1_000_000n, 0n, 6)).toBeNull();
  expect(sharePrice(null, 10n, 6)).toBeNull();
});
test("reads a full snapshot inside the call budget", async () => {
  const rpc = fakeRpc(vaultViews);
  const s = await readVaultSnapshot(rpc, "vault.near", () => 1234);
  expect(rpc.calls).toBeLessThanOrEqual(27);
  expect(s).toMatchObject({
    vaultId: "vault.near", blockHeight: 200n, chainTimeSeconds: 1800000000n, fetchedAtMs: 1234,
    stage: { kind: "Idle" }, lastNonce: 41n, totalShares: 96_000_000_000_000n, accessKeys: 0,
    storageMin: 15_000_000_000_000_000_000_000n, price: { near: 250_000_000n, usdc: 100_000_000n },
    revealed: false, setupDone: true,
  });
  expect(s.agent).toEqual({ wasmHash: "ab".repeat(32), wasmUrl: "https://example.org/strategy.wasm", commitment: "cd".repeat(32), revealAfter: 1800100000n });
  expect(s.account.codeHash).toBe("CodeHash");
});
test("a null feed or mismatched exponents give no price", async () => {
  const nullFeed = { ...vaultViews, list_prices_no_older_than: { "near.price": null, "usdc.price": { price: "1", conf: "0", expo: -8, publish_time: 1 } } };
  expect((await readVaultSnapshot(fakeRpc(nullFeed), "vault.near")).price).toBeNull();
  const expo = { ...vaultViews, list_prices_no_older_than: { "near.price": { price: "1", conf: "0", expo: -6, publish_time: 1 }, "usdc.price": { price: "1", conf: "0", expo: -8, publish_time: 1 } } };
  expect((await readVaultSnapshot(fakeRpc(expo), "vault.near")).price).toBeNull();
});
test("a fallback answer from an older block never replaces a newer one", async () => {
  const snap = await readVaultSnapshot(fakeRpc(vaultViews), "vault.near");
  const newer: VaultSnapshot = { ...snap, blockHeight: 200n };
  const older: VaultSnapshot = { ...snap, blockHeight: 199n, halted: true };
  expect(acceptSnapshot(newer, older)).toBe(newer);
  expect(acceptSnapshot(older, newer)).toBe(newer);
  expect(acceptSnapshot(null, older)).toBe(older);
});
test("reads a position across the vault and both tokens", async () => {
  const s = await readVaultSnapshot(fakeRpc(vaultViews), "vault.near");
  const rpc = fakeRpc(
    { shares_of: "5", pending_of: "2", net_deposit_of: "7", claimable_of: "1", storage_balance_of: { total: "1", available: "0" }, is_allowed: true },
    {
      [s.assets.usdc]: { storage_balance_of: null, ft_balance_of: "3000000" },
      "wrap.near": { storage_balance_of: { total: "1", available: "0" } },
      "usdce.near": { ft_balance_of: "9" },
    },
  );
  const p = await readPosition(rpc, s, "alice.near", "usdce.near");
  expect(p).toEqual({
    account: "alice.near", shares: 5n, pending: 2n, netDeposit: 7n, claimable: { usdc: 1n, wnear: 1n },
    registered: { vault: true, usdc: false, wnear: true }, balances: { usdc: 3_000_000n, usdcE: 9n, near: 10n ** 25n }, allowed: true,
  });
});
test("a snapshot carries the oldest block any of its views came from", async () => {
  const rpc = fakeRpc(vaultViews);
  const view = rpc.view.bind(rpc);
  rpc.view = (async (c: string, m: string, a: object, p: (r: unknown) => unknown) => {
    const r = await view(c, m, a, p);
    return m === "stage" ? { ...r, blockHeight: 150n } : r;
  }) as typeof rpc.view;
  expect((await readVaultSnapshot(rpc, "vault.near")).blockHeight).toBe(150n);
});
