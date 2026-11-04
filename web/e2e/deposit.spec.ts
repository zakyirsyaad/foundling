import { type Page, expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

async function connect(page: Page) {
  await page.goto("/app/portfolio");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(page.getByTestId("queue")).toBeVisible();
}

test("a new account registers and deposits in one wallet request", async ({ page, request }) => {
  await useScenario(request, "normal");
  await connect(page);
  await expect(page.getByText(/one-time, non-refundable registration/)).toBeVisible();
  await expect(page.getByText("Not audited. You can lose money.")).toBeVisible();
  await page.getByLabel("Amount in USDC").fill("5");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  const sent = await page.evaluate(() => window.__mockWallet?.sent.map((t) => t.methodName));
  expect(sent).toEqual(["storage_deposit", "ft_transfer_call"]);
  await expect(page.getByTestId("queue")).toContainText("5 USDC");
  await expect(page.getByTestId("queue")).toContainText("Shares mint at the next cycle.");
});
test("cancelling in the wallet keeps the form filled", async ({ page, request }) => {
  await useScenario(request, "normal");
  await connect(page);
  await page.getByLabel("Amount in USDC").fill("7");
  await page.evaluate(() => (window.__mockWallet!.next = "cancel"));
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(page.getByText("Cancelled in your wallet. Nothing was sent.")).toBeVisible();
  await expect(page.getByLabel("Amount in USDC")).toHaveValue("7");
});
test("a frozen vault closes the form but a queued deposit can still be cancelled", async ({ page, request }) => {
  await useScenario(request, "frozen-with-queue");
  await connect(page);
  await expect(page.getByText("The vault is frozen. New deposits are paused.")).toBeVisible();
  await expect(page.getByLabel("Amount in USDC")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel queued deposit" }).click();
  await expect(page.getByTestId("queue")).toContainText("0 USDC");
});
test("with the API down the portfolio works the same", async ({ page, request }) => {
  await useScenario(request, "api-down");
  await connect(page);
  await expect(page.getByLabel("Amount in USDC")).toBeVisible();
});
test("every action has a CLI command", async ({ page, request }) => {
  await useScenario(request, "normal");
  await connect(page);
  const deposit = page.getByRole("region", { name: "Deposit" });
  await deposit.getByText("CLI command").click();
  await expect(deposit.locator("code").filter({ hasText: "ft_transfer_call" })).toContainText("network-config testnet sign-with-keychain send");
  for (const name of ["Redeem", "Claims"]) await expect(page.getByRole("region", { name }).getByText("CLI command")).toHaveCount(1);
});
test("the testnet build never renders deposits from another chain", async ({ page, request }) => {
  await useScenario(request, "normal");
  await connect(page);
  await expect(page.getByRole("heading", { name: "From another chain" })).toHaveCount(0);
});
