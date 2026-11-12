import type { Position } from "@/lib/chain/types";
import { depositChecks, depositGate, nearShortfallFor, remainingVaultCap } from "@/lib/vault/deposit";
import { fixtureSnapshot } from "../fixtures/snapshot";

const pos: Position = {
  account: "alice.near", shares: 0n, pending: 0n, netDeposit: 0n, claimable: { usdc: 0n, wnear: 0n },
  registered: { vault: true, usdc: true, wnear: true }, balances: { usdc: 50_000_000n, usdcE: 0n, near: 10n ** 24n }, allowed: true,
};

test("gate lists every reason, not only the first", async () => {
  const snap = await fixtureSnapshot();
  expect(depositGate({ ...snap, frozen: true, setupDone: false }, pos, false).reasons).toEqual(["frozen", "not-ready"]);
  expect(depositGate({ ...snap, halted: true }, pos, false).reasons).toEqual(["halted"]);
  expect(depositGate({ ...snap, account: { ...snap.account, amount: 0n } }, pos, false).reasons).toEqual(["low-vault-near"]);
  expect(depositGate({ ...snap, policy: { ...snap.policy, openDeposits: false } }, { ...pos, allowed: false }, false).reasons).toEqual(["closed-allowlist"]);
  expect(depositGate({ ...snap, policy: { ...snap.policy, openDeposits: false } }, pos, false)).toEqual({ open: true, reasons: [] });
  expect(depositGate(snap, pos, true).reasons).toEqual(["unreadable"]);
  expect(depositGate(snap, null, false)).toEqual({ open: true, reasons: [] });
});
test("NEAR shortfall counts deposits and gas exactly", () => {
  const txs = [
    { receiverId: "v", methodName: "storage_deposit", args: {}, gas: 50n * 10n ** 12n, deposit: 15n * 10n ** 21n },
    { receiverId: "u", methodName: "ft_transfer_call", args: {}, gas: 120n * 10n ** 12n, deposit: 1n },
  ];
  expect(nearShortfallFor(txs, 0n, 100_000_000n)).toBe(15n * 10n ** 21n + 1n + 170n * 10n ** 12n * 100_000_000n);
  expect(nearShortfallFor(txs, 10n ** 24n, 100_000_000n)).toBe(0n);
});
test("checks before the deposit button", async () => {
  const snap = await fixtureSnapshot();
  const r = depositChecks(5_000_000n, snap, { ...pos, registered: { ...pos.registered, vault: false }, balances: { ...pos.balances, near: 0n } }, 100_000_000n);
  // register_vault 30+20 TGas with the 0.015 NEAR fee, deposit 100+20 TGas with 1 yocto
  expect(r.nearShortfall).toBe(snap.storageMin + 1n + (50n + 120n) * 10n ** 12n * 100_000_000n);
  expect(r.needsRegistration).toBe(true);
  expect(r.belowMin).toBe(false);
  expect(r.remainingUserCap).toBe(100_000_000n);
  expect(r.tvlRemainingEstimate).toBe(1_000_000_000n - 96_400_000n);
});
test("below min_deposit and over per_user_cap are flagged", async () => {
  const snap = await fixtureSnapshot();
  expect(depositChecks(999_999n, snap, pos, 1n).belowMin).toBe(true);
  const near = depositChecks(30_000_000n, snap, { ...pos, netDeposit: 80_000_000n }, 1n);
  expect(near.remainingUserCap).toBe(20_000_000n);
  expect(near.overUserCap).toBe(true);
  expect(depositChecks(60_000_000n, snap, pos, 1n).overBalance).toBe(true);
});

test("remainingVaultCap is the TVL estimate the cross-chain card warns from", async () => {
  const snap = await fixtureSnapshot();
  expect(remainingVaultCap(snap)).toBe(1_000_000_000n - 96_400_000n);
  expect(remainingVaultCap({ ...snap, policy: { ...snap.policy, tvlCap: 1n } })).toBe(0n);
});
