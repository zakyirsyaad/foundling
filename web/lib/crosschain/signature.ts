import { type OneClickQuoteResponse, verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";

/** Verifies with the key pinned in config, always passed explicitly, never the SDK's default. */
export function verifyQuote(res: OneClickQuoteResponse, publicKey: string): boolean {
  if (!publicKey) return false;
  return verifyQuoteSignature(res, publicKey);
}

/** USDC that arrives must be depositable: at least min_deposit and within what the account can still add. */
export function quoteProblems(res: OneClickQuoteResponse, v: { minDeposit: bigint; remainingUserCap: bigint }): ("below-min" | "over-cap")[] {
  const minOut = BigInt(String((res as { quote?: { minAmountOut?: string } }).quote?.minAmountOut ?? "0"));
  const problems: ("below-min" | "over-cap")[] = [];
  if (minOut < v.minDeposit) problems.push("below-min");
  if (minOut > v.remainingUserCap) problems.push("over-cap");
  return problems;
}
