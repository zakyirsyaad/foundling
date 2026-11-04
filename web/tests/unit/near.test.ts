import { vaultNearOk } from "@/lib/vault/near";

test("vault NEAR is checked against storage stake plus reserve", () => {
  expect(vaultNearOk({ amount: 10n ** 24n + 100n * 10n ** 19n, storageUsage: 100n, codeHash: "" }, 10n ** 24n)).toBe(true);
  expect(vaultNearOk({ amount: 10n ** 24n + 99n * 10n ** 19n, storageUsage: 100n, codeHash: "" }, 10n ** 24n)).toBe(false);
});
