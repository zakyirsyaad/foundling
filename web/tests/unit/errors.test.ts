import { contractErrorSentence } from "@/lib/vault/errors";

test("known contract errors become plain sentences", () => {
  expect(contractErrorSentence("Smart contract panicked: NOT_STUCK")).toMatch(/not stuck/i);
  expect(contractErrorSentence("Smart contract panicked: bucket not resolved")).toMatch(/swap.*finish/i);
  expect(contractErrorSentence("Smart contract panicked: LOW_GAS")).toMatch(/gas/i);
  expect(contractErrorSentence("attach exactly the registration fee")).toMatch(/registration/i);
  expect(contractErrorSentence("Smart contract panicked: already registered")).toMatch(/already registered/i);
  for (const code of ["FROZEN", "HALTED", "COOLDOWN", "NOT_EXPIRED", "NOT_STALE"]) expect(contractErrorSentence(`panicked: ${code}`)).not.toBe("The contract rejected this transaction.");
});
test("unknown contract errors keep a generic sentence", () => {
  expect(contractErrorSentence("Smart contract panicked: WEIRD")).toBe("The contract rejected this transaction.");
});
test("no sentence for NOT_ALLOWED: the vault refunds a deposit from outside the allowlist instead of panicking", () => {
  expect(contractErrorSentence("Smart contract panicked: NOT_ALLOWED")).toBe("The contract rejected this transaction.");
});
