import { dataAge, limitMeters, positionValue, sharePriceSinceStart, vaultHeadline, vaultWord } from "@/lib/vault/overview";
import { fixtureSnapshot } from "../fixtures/snapshot";

test("halted outranks frozen and stuck", async () => {
  const snap = await fixtureSnapshot();
  expect(vaultWord({ ...snap, halted: true, frozen: true })).toBe("Halted");
  expect(vaultWord({ ...snap, frozen: true })).toBe("Frozen");
  expect(vaultWord({ ...snap, stage: { kind: "Stuck", nonce: 1n, step: "Swap", attempt: 0, since: 1n } })).toBe("Stuck");
  expect(vaultWord({ ...snap, setupDone: false })).toBe("Not ready");
  expect(vaultWord({ ...snap, selftestPassed: false })).toBe("Not ready");
  expect(vaultWord(snap)).toBe("Live");
});
test("a swap past stuck_after reads as Stuck before the contract flips the stage", async () => {
  const snap = await fixtureSnapshot();
  const stage = { kind: "Swapping" as const, nonce: 1n, attempt: 0, enteredAt: snap.chainTimeSeconds - snap.policy.stuckAfter };
  expect(vaultWord({ ...snap, stage })).toBe("Stuck");
});
test("share price change is never annualised", () => {
  const r = sharePriceSinceStart(1_004_200n, 41n, "2026-11-01T00:00:00Z", Date.parse("2026-11-11T00:00:00Z"));
  expect(r).toEqual({ label: "Share price since start", changeBps: 42n, periodDays: 10, cycles: 41n });
  expect(sharePriceSinceStart(990_000n, 3n, null, 0)).toEqual({ label: "Share price since start", changeBps: -100n, periodDays: null, cycles: 3n });
  expect(sharePriceSinceStart(null, 3n, null, 0).changeBps).toBeNull();
});
test("data older than 60 s is unreadable", async () => {
  const snap = await fixtureSnapshot();
  expect(dataAge({ ...snap, fetchedAtMs: 0 }, 60_000)).toEqual({ ageSeconds: 60, unreadable: false });
  expect(dataAge({ ...snap, fetchedAtMs: 0 }, 60_001).unreadable).toBe(true);
});
test("the four meters follow the contract caps", async () => {
  const snap = await fixtureSnapshot();
  // NAV 96.40 USDC, epoch cap min(50% of NAV, 30 USDC) = 30 USDC
  const m = limitMeters({ ...snap, windowUsed: { usdc: 12_400_000n, wnear: 0n } });
  expect(m.epochWindow).toEqual({ used: 12_400_000n, cap: 30_000_000n, estimate: false });
  expect(m.opsBudget).toEqual({ used: 1_250_000n, cap: 5_000_000n, estimate: false });
  expect(m.tvl).toEqual({ used: 96_400_000n, cap: 1_000_000_000n, estimate: true });
  expect(m.exposure).toEqual({ used: 0n, cap: 57_840_000n, estimate: false });
});
test("meters that need a price say so when there is none", async () => {
  const snap = await fixtureSnapshot();
  const m = limitMeters({ ...snap, book: { usdc: 1n, wnear: 1n }, price: null });
  expect(m.exposure).toEqual({ used: null, cap: null, estimate: false });
  expect(m.epochWindow.cap).toBeNull();
  expect(m.opsBudget.cap).toBe(5_000_000n);
});

test("the headline says in one sentence what the vault is doing", async () => {
  const s = await fixtureSnapshot();
  expect(vaultHeadline(s)).toBe("Waiting for the next cycle.");
  expect(vaultHeadline({ ...s, frozen: true })).toBe("Trading is paused. Redeem still works.");
  expect(vaultHeadline({ ...s, halted: true, frozen: true })).toBe("Trading has stopped. Redeem still works.");
  expect(vaultHeadline({ ...s, setupDone: false })).toBe("The vault is not ready for deposits yet.");
});
test("a position is worth its share of the book, rounded down", () => {
  expect(positionValue(96_400_000n, 48n * 10n ** 12n, 96n * 10n ** 12n)).toBe(48_200_000n);
  expect(positionValue(10n, 1n, 3n)).toBe(3n);
  expect(positionValue(null, 1n, 3n)).toBeNull();
  expect(positionValue(10n, 1n, 0n)).toBeNull();
});
