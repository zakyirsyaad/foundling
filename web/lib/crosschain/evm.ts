import { keccak_256 } from "@noble/hashes/sha3.js";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** An EVM address: 0x and 40 hex digits; mixed case must pass the EIP-55 checksum. */
export function isEvmAddress(text: string): boolean {
  if (!HEX40.test(text)) return false;
  const body = text.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = keccak_256(new TextEncoder().encode(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const ch = body[i]!;
    if (/[a-f]/i.test(ch) && (nibble >= 8 ? ch !== ch.toUpperCase() : ch !== ch.toLowerCase())) return false;
  }
  return true;
}
