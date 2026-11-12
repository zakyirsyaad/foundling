import { MAX_SAFE_U64, toJsonNonce } from "@/lib/chain/nonce";

test("ordinary nonces keep their number value", () => {
  expect(toJsonNonce(0n)).toBe(0);
  expect(toJsonNonce(40n)).toBe(40);
  expect(toJsonNonce(MAX_SAFE_U64)).toBe(Number.MAX_SAFE_INTEGER);
});
test("a nonce above 2^53 is refused instead of rounded", () => {
  expect(toJsonNonce(2n ** 53n)).toBeNull();
  expect(toJsonNonce(2n ** 53n + 1n)).toBeNull();
  expect(toJsonNonce(-1n)).toBeNull();
});
