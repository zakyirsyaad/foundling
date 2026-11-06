import { historyPendingText } from "@/lib/cycles/fallback";

test("pending history only blames the vault when the vault itself cannot be read", () => {
  expect(historyPendingText(false)).toBe("History is pending and the vault is not readable right now.");
  expect(historyPendingText(true)).toBe("History is pending, and the latest cycles could not be read from the chain right now. Try again in a moment.");
});
