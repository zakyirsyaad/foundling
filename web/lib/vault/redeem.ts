import type { Book, Position } from "@/lib/chain/types";

/** What `redeem(shares)` pays now: `book · shares / totalShares`, rounded down like `payout`. */
export function redeemEstimate(book: Book, shares: bigint, totalShares: bigint): { usdc: bigint; wnear: bigint } {
  if (totalShares === 0n || shares === 0n) return { usdc: 0n, wnear: 0n };
  return { usdc: (book.usdc * shares) / totalShares, wnear: (book.wnear * shares) / totalShares };
}

/** The contract reverts a redeem whose every payout is zero. */
export function canRedeem(est: { usdc: bigint; wnear: bigint }): boolean {
  return est.usdc > 0n || est.wnear > 0n;
}

/** Register with both tokens first, so a payout never falls into `claimable` for lack of storage. */
export function redeemPrereqs(p: Position): ("register_usdc" | "register_wnear")[] {
  return [...(p.registered.usdc ? [] : ["register_usdc" as const]), ...(p.registered.wnear ? [] : ["register_wnear" as const])];
}
