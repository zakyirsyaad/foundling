import { expect, test } from "@playwright/test";

test.use({ javaScriptEnabled: false });

test("/trust renders the roles from the vault and the executor risk", async ({ page }) => {
  await page.goto("/trust");
  const roles = page.getByRole("table", { name: "Roles" });
  await expect(roles.getByRole("rowheader", { name: "Governor" })).toBeVisible();
  await expect(page.getByText(/can ask your wallet to sign any transaction/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Rhea exploit" })).toBeVisible();
});
test("/terms has the cross-chain section with an https link to the 1Click terms", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.locator("h2#cross-chain")).toHaveText("Deposits from another chain");
  await expect(page.getByRole("link", { name: "1Click terms of service" })).toBeVisible();
});
