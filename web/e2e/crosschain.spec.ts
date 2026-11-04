import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

import { MOCK, useScenario } from "./helpers";

const REFUND = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const card = (page: Page) => page.getByRole("region", { name: "From another chain" });

async function setStatus(request: APIRequestContext, status: string, swapDetails: object = {}) {
  await request.post(`${MOCK}/__oneclick/status`, { data: { status, swapDetails } });
}

async function toQuote(page: Page) {
  await page.goto("/app/portfolio");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(card(page).getByLabel("USDC to send")).toBeVisible();
  await card(page).getByLabel("USDC to send").fill("5");
  await card(page).getByLabel("Refund address on Base").fill(REFUND);
  await card(page).getByRole("button", { name: "Get a quote" }).click();
}

async function toAddress(page: Page) {
  await toQuote(page);
  await card(page).getByRole("button", { name: "Register" }).click();
  await card(page).getByRole("button", { name: "Continue" }).click();
  await card(page).getByRole("button", { name: "Get the deposit address" }).click();
  await expect(card(page).getByTestId("deposit-address")).toBeVisible();
}

test.beforeEach(async ({ request }) => useScenario(request, "normal"));

test("Base: quote, register, address, SUCCESS, then deposit", async ({ page, request }) => {
  await toQuote(page);
  await expect(card(page)).toContainText("Arrives (about)");
  await card(page).getByRole("button", { name: "Register" }).click();
  await card(page).getByRole("button", { name: "Continue" }).click();
  await expect(card(page).getByRole("link", { name: "terms for deposits from another chain" })).toHaveAttribute("href", "/terms#cross-chain");
  await card(page).getByRole("button", { name: "Get the deposit address" }).click();
  await expect(card(page).getByTestId("deposit-address")).toContainText("0xDep");
  await expect(card(page).getByTestId("send-before")).toContainText("Send before");
  await expect(card(page)).toContainText("USDbC is not the token asked for.");
  await setStatus(request, "SUCCESS", { amountOut: "4999800" });
  await card(page).getByRole("button", { name: /^Deposit 4.9998 USDC$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Done." })).toBeVisible();
});
test("an incomplete deposit keeps the address for a top-up", async ({ page, request }) => {
  await toAddress(page);
  await setStatus(request, "INCOMPLETE_DEPOSIT");
  await expect(card(page).getByTestId("swap-status")).toContainText("INCOMPLETE_DEPOSIT");
  await expect(card(page).getByTestId("deposit-address")).toBeVisible();
});
test("REFUNDED shows the refund address and amount; FAILED promises nothing", async ({ page, request }) => {
  await toAddress(page);
  await setStatus(request, "REFUNDED", { refundedAmount: "4997600", refundReason: "deadline" });
  await expect(card(page)).toContainText(`refunded the swap to ${REFUND}: 4.9976 USDC (deadline)`);
  await setStatus(request, "FAILED");
  await expect(card(page)).toContainText("No refund is promised here.");
});
test("1Click down: the card says so and the NEAR deposit still works", async ({ page, request }) => {
  await useScenario(request, "oneclick-down");
  await page.goto("/app/portfolio");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(card(page)).toContainText("1Click did not answer");
  await expect(page.getByLabel("Amount in USDC")).toBeVisible();
});
test("a quote with a bad signature never shows an address", async ({ page, request }) => {
  await useScenario(request, "oneclick-bad-signature");
  await toQuote(page);
  await expect(card(page).getByRole("alert")).toContainText("signature did not verify");
});
test("a quote that does not echo the request never shows an address", async ({ page, request }) => {
  await useScenario(request, "oneclick-bad-echo");
  await toQuote(page);
  await expect(card(page).getByRole("alert")).toContainText("does not match what was asked (recipient)");
});
test("after a reload the address is gone, the swap is listed, and a second quote is blocked", async ({ page }) => {
  await toAddress(page);
  const address = (await card(page).getByTestId("deposit-address").innerText()).trim();
  await page.reload();
  await expect(card(page).getByTestId("deposit-address")).toHaveCount(0);
  await expect(card(page)).not.toContainText(address);
  await expect(card(page).getByRole("list", { name: "Earlier swaps" })).toContainText("in progress");
  await expect(card(page)).toContainText("A second quote now risks a second send.");
});
test("a hidden tab hides the address until the time is checked and the user says nothing was sent", async ({ page }) => {
  await toAddress(page);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(card(page).getByTestId("deposit-address")).toHaveCount(0);
  await card(page).getByRole("button", { name: "Check the time" }).click();
  await expect(card(page)).toContainText("Already sent? Paste the tx hash");
  await card(page).getByRole("button", { name: "I have not sent anything yet" }).click();
  await expect(card(page).getByTestId("deposit-address")).toBeVisible();
});
test("a device clock that disagrees with 1Click by 30 minutes gets Do not send", async ({ page, request }) => {
  await useScenario(request, "oneclick-clock-skew");
  await toQuote(page);
  await card(page).getByRole("button", { name: "Register" }).click();
  await card(page).getByRole("button", { name: "Continue" }).click();
  await card(page).getByRole("button", { name: "Get the deposit address" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Do not send to this address any more.");
  await expect(card(page).getByTestId("deposit-address")).toHaveCount(0);
});
test("a refund address with a bad checksum is refused", async ({ page }) => {
  await page.goto("/app/portfolio");
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await card(page).getByLabel("USDC to send").fill("5");
  await card(page).getByLabel("Refund address on Base").fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD");
  await expect(card(page)).toContainText("Not a valid EVM address.");
  await expect(card(page).getByRole("button", { name: "Get a quote" })).toBeDisabled();
});
