/** JSON numbers are IEEE-754 doubles, so a u64 above this cannot be sent exactly. */
export const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

/** A nonce as the JSON number a u64 argument expects, or null when it cannot be represented exactly. */
export function toJsonNonce(nonce: bigint): number | null {
  if (nonce < 0n || nonce > MAX_SAFE_U64) return null;
  const n = Number(nonce);
  return Number.isSafeInteger(n) && BigInt(n) === nonce ? n : null;
}
