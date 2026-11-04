/** What to deposit after SUCCESS: the smallest of what arrived, what the account holds, and what it may still add. */
export function depositAmount(amountOut: bigint, usdcBalance: bigint, remainingUserCap: bigint, minDeposit: bigint): { amount: bigint; excess: bigint; belowMin: boolean } {
  const amount = [amountOut, usdcBalance, remainingUserCap].reduce((a, b) => (a < b ? a : b));
  return { amount, excess: amountOut > amount ? amountOut - amount : 0n, belowMin: amount < minDeposit };
}
