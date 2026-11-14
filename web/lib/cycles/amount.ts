import { formatUnits, NEAR_DECIMALS } from "@/lib/format/units";

const USDC_DECIMALS = 6;
const USDC_SHOWN = 2;
const WNEAR_SHOWN = 4;

/**
 * What went into a cycle's swap, with its unit. The `executed` event carries both amounts and
 * no direction. wNEAR has 24 decimals and USDC has 6, so the wNEAR side is the larger raw
 * number at any NEAR price under 10^18 USD: a sell is the swap whose input is the larger one.
 * With no other side to compare, the amount reads as USDC.
 */
export function tradeAmountText(amountIn: bigint | null, amountOut: bigint | null): string {
  if (amountIn === null) return "—";
  const sold = amountOut !== null && amountIn > amountOut;
  return sold ? `${formatUnits(amountIn, NEAR_DECIMALS, WNEAR_SHOWN)} wNEAR` : `${formatUnits(amountIn, USDC_DECIMALS, USDC_SHOWN)} USDC`;
}
