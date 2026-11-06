import type { Position } from "@/lib/chain/types";
import { canRedeem, redeemEstimate, redeemPrereqs } from "@/lib/vault/redeem";

const pos: Position = { account: "a.near", shares: 1n, pending: 0n, netDeposit: 0n, claimable: { usdc: 0n, wnear: 0n }, registered: { vault: true, usdc: true, wnear: true }, balances: { usdc: 0n, usdcE: 0n, near: 0n }, allowed: true };

test("estimate floors like the contract payout", () => {
  expect(redeemEstimate({ usdc: 10n, wnear: 7n }, 1n, 3n)).toEqual({ usdc: 3n, wnear: 2n });
  expect(redeemEstimate({ usdc: 10n, wnear: 7n }, 0n, 3n)).toEqual({ usdc: 0n, wnear: 0n });
  expect(redeemEstimate({ usdc: 10n, wnear: 7n }, 3n, 0n)).toEqual({ usdc: 0n, wnear: 0n });
  expect(redeemEstimate({ usdc: 2n ** 120n, wnear: 0n }, 2n ** 100n, 2n ** 101n)).toEqual({ usdc: 2n ** 119n, wnear: 0n });
});
test("a redeem that pays nothing is refused, as the contract does", () => {
  expect(canRedeem({ usdc: 0n, wnear: 0n })).toBe(false);
  expect(canRedeem({ usdc: 0n, wnear: 1n })).toBe(true);
});
test("redeem asks for both token registrations first", () => {
  expect(redeemPrereqs({ ...pos, registered: { vault: true, usdc: false, wnear: false } })).toEqual(["register_usdc", "register_wnear"]);
  expect(redeemPrereqs({ ...pos, registered: { vault: true, usdc: true, wnear: false } })).toEqual(["register_wnear"]);
  expect(redeemPrereqs(pos)).toEqual([]);
});
