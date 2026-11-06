import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ request }) => useScenario(request, "api-down"));

test("/proof renders from the m12 sample with no API and no JavaScript", async ({ page }) => {
  await page.goto("/proof");
  await expect(page.getByTestId("proof-source")).toContainText("Testnet rehearsal vault (m12)");
  await expect(page.locator("[data-fact=keys]")).toContainText("1 access key");
  await expect(page.locator("[data-fact=keys]")).toContainText("This rehearsal vault has keys.");
  await expect(page.locator("[data-fact] pre")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Copy command" })).toHaveCount(4);
});
test("/proof lists the Attack Lab as sandbox results", async ({ page }) => {
  await page.goto("/proof");
  await expect(page.locator("#attack-lab")).toBeVisible();
  await expect(page.getByRole("cell", { name: "over-cap", exact: true })).toBeVisible();
  await expect(page.getByText("Sandbox results.")).toBeVisible();
});
