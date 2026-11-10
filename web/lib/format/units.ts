const U128_MAX = 2n ** 128n - 1n;
const DECIMAL = /^\d+$/;
const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/** Native NEAR, counted in yoctoNEAR. */
export const NEAR_DECIMALS = 24;

/** Formats a base-unit amount with `decimals` places, rounded down, trailing zeros dropped. */
export function formatUnits(value: bigint, decimals: number, maxFraction: number = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

/** Parses a non-negative decimal string into base units. Throws on extra precision. */
export function parseUnits(text: string, decimals: number): bigint {
  const match = AMOUNT.exec(text.trim());
  if (!match) throw new Error(`not an amount: ${text}`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) throw new Error(`more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Parses a JSON U128, which near-sdk sends as a decimal string. */
export function parseU128(raw: unknown): bigint {
  if (typeof raw !== "string" || !DECIMAL.test(raw)) throw new Error(`not a U128 string: ${String(raw)}`);
  const value = BigInt(raw);
  if (value > U128_MAX) throw new Error("U128 out of range");
  return value;
}
