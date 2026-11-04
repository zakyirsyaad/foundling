import { type Page, expect, test } from "@playwright/test";

import { MOCK, useScenario } from "./helpers";

async function connect(page: Page) {
  await page.goto("/app/portfolio");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.getByTestId("shares")).toBeVisible();
}

test("redeem during a swap is partial, and the claim opens once the swap is done", async ({ page, request }) => {
  await useScenario(request, "swap-running");
  await connect(page);
  await expect(page.getByTestId("redeem-estimate")).toContainText("9.64 USDC");
  await page.getByRole("button", { name: "Redeem", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Partly done." })).toBeVisible();
  const sent = await page.evaluate(() => window.__mockWallet?.sent.map((t) => t.methodName));
  expect(sent).toEqual(["storage_deposit", "storage_deposit", "redeem"]);
  await useScenario(request, "swap-done");
  await page.reload();
  await expect(page.locator("[data-claim-nonce='9']").getByRole("button", { name: "Claim" })).toBeVisible();
});
test("a failed transfer shows in claimable with a withdraw button", async ({ page, request }) => {
  await useScenario(request, "claimable");
  await connect(page);
  await page.getByRole("button", { name: "Withdraw USDC" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Done." })).toBeVisible();
});
test("a reload after signing resumes the status and does not send again", async ({ page, request }) => {
  await useScenario(request, "claimable");
  await connect(page);
  const count = async () => (await (await request.get(`${MOCK}/__tx`)).json()).count as number;
  await page.getByRole("button", { name: "Withdraw USDC" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  const afterSend = await count();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await count()).toBe(afterSend);
});
