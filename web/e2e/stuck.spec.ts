import { type Page, expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

async function connect(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
}

test("a stuck vault shows the panel on /app and /app/portfolio", async ({ page, request }) => {
  await useScenario(request, "stuck");
  await page.goto("/app");
  await expect(page.getByTestId("stuck-panel")).toContainText("Vault stuck");
  await connect(page, "/app/portfolio");
  await expect(page.getByTestId("stuck-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Advance cycle 9" })).toHaveAttribute("data-variant", "primary");
  await expect(page.getByRole("button", { name: "Redeem", exact: true })).not.toHaveAttribute("data-variant", "primary");
});
test("advance answered NOT_STUCK shows a plain sentence", async ({ page, request }) => {
  await useScenario(request, "stuck");
  await connect(page, "/app/portfolio");
  const advance = page.getByRole("button", { name: "Advance cycle 9" });
  await expect(advance).toBeEnabled();
  await page.evaluate(() => (window.__mockWallet!.next = "contract:NOT_STUCK"));
  await advance.click();
  await expect(page.getByRole("alert").filter({ hasText: "The vault is not stuck yet" })).toBeVisible();
});
test("a stale awaiting stage offers only abort_stale_cycle", async ({ page, request }) => {
  await useScenario(request, "awaiting-stale");
  await connect(page, "/app/portfolio");
  await expect(page.getByRole("button", { name: "Abort stale cycle" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Advance/ })).toHaveCount(0);
});
