import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

test.describe("server HTML", () => {
  test.use({ javaScriptEnabled: false });
  test("/app renders the stage and the book without JavaScript", async ({ page, request }) => {
    await useScenario(request, "normal");
    await page.goto("/app");
    await expect(page.getByTestId("stage-bar")).toContainText("Live");
    await expect(page.getByTestId("stage-bar")).toContainText("Stage: Idle");
    await expect(page.getByText("96.4 USDC").first()).toBeVisible();
    await expect(page.getByTestId("network-badge")).toHaveText("testnet");
  });
});

test("with the API down the live numbers stay and history is pending", async ({ page, request }) => {
  await useScenario(request, "api-down");
  await page.goto("/app");
  await expect(page.getByText(/History is pending. Live numbers/)).toBeVisible();
  await expect(page.getByText("Last cycle #41. History is pending.")).toBeVisible();
  await expect(page.getByText("96.4 USDC").first()).toBeVisible();
});
test("a frozen vault shows the Frozen banner", async ({ page, request }) => {
  await useScenario(request, "frozen");
  await page.goto("/app");
  await expect(page.getByRole("status").filter({ hasText: "Frozen" })).toContainText("Redeem, claims and cancelling");
});
test("share price change is labelled and never annualised", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.goto("/app");
  await expect(page.getByText("Share price since start")).toBeVisible();
  await expect(page.getByText(/^\d+ days · 41 cycles$/)).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/APY|\/yr|per year|annual/i);
});
test("the app tabs mark the current page", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.goto("/app");
  await expect(page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
});
