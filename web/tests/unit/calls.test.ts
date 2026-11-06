import { loadConfig } from "@/config/deployment";
import { CALLS, GAS_MARGIN_TGAS, buildTx } from "@/lib/wallet/calls";
import { assetsSchema } from "@/lib/chain/types";
import { assetsJson } from "../fixtures/vault";

const mainnetEnv = { NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_VAULT_ID: "foundling-vault.near", NEXT_PUBLIC_RPC_URLS: "https://rpc.mainnet.fastnear.com" };
const config = loadConfig(mainnetEnv);
const ctx = { config, assets: assetsSchema.parse(assetsJson), storageMin: { vault: 15n * 10n ** 21n, usdc: 125n * 10n ** 19n, wnear: 125n * 10n ** 19n } };
const TGAS = 10n ** 12n;

test("refuses to build a call when the config USDC differs from the vault", () => {
  expect(() => buildTx("deposit", { amount: "1" }, { ...ctx, assets: { ...ctx.assets, usdc: "other.near" } })).toThrow(/USDC/);
  expect(() => buildTx("register_wnear", {}, { ...ctx, assets: { ...ctx.assets, wnear: "evil.near" } })).toThrow(/wNEAR/);
});
test("adds the margin over the contract minimum", () => {
  expect(GAS_MARGIN_TGAS).toBe(20);
  expect(buildTx("redeem", { shares: "1" }, ctx).gas).toBe(115n * TGAS);
  expect(buildTx("cancel_deposit", {}, ctx).gas).toBe(75n * TGAS);
  expect(buildTx("advance", { nonce: 3 }, ctx).gas).toBe(130n * TGAS);
  expect(buildTx("abort_stale_cycle", {}, ctx).gas).toBe(50n * TGAS);
});
test("deposits and registrations attach what the spec says", () => {
  expect(buildTx("redeem", { shares: "1" }, ctx).deposit).toBe(1n);
  expect(buildTx("advance", { nonce: 3 }, ctx).deposit).toBe(0n);
  expect(buildTx("register_vault", {}, ctx)).toMatchObject({ receiverId: config.vaultId, methodName: "storage_deposit", deposit: ctx.storageMin.vault });
  expect(buildTx("register_usdc", {}, ctx)).toMatchObject({ receiverId: config.usdc, methodName: "storage_deposit", deposit: ctx.storageMin.usdc });
  expect(buildTx("deposit", { amount: "5" }, ctx)).toMatchObject({ receiverId: config.usdc, methodName: "ft_transfer_call", deposit: 1n, args: { receiver_id: config.vaultId, amount: "5", msg: "deposit" } });
});
test("every call in the table targets the vault or a pinned token", () => {
  for (const [name, spec] of Object.entries(CALLS)) {
    const tx = buildTx(name as keyof typeof CALLS, {}, ctx);
    expect([config.vaultId, config.usdc, config.wnear]).toContain(tx.receiverId);
    expect(tx.methodName).toBe(spec.method);
    expect(tx.gas).toBeLessThanOrEqual(300n * TGAS);
  }
});
test("the mainnet config loads and its USDC is the 64-hex implicit account", () => {
  expect(config.usdc).toMatch(/^[0-9a-f]{64}$/);
});
