import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

test.describe("server HTML", () => {
  test.use({ javaScriptEnabled: false });

  test("carries the headline and the verifier line", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A vault born without keys.");
    await expect(page.getByTestId("keys-line")).toContainText("Testnet rehearsal (m12)");
    await expect(page.getByTestId("keys-line")).toContainText("access key");
  });
  test("sections come in the spec order", async ({ page }) => {
    await page.goto("/");
    const ids = await page.locator("main > section").evaluateAll((s) => s.map((e) => e.id));
    expect(ids).toEqual(["hero", "built-on", "how-it-works", "demo", "guarantees", "not-claimed", "closing"]);
  });
  test("the header and footer carry the spec links", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const name of ["Foundling", "How it works", "Proof", "Trust", "GitHub", "Open app"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toContainText("Not audited · hackathon build");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Terms" })).toBeVisible();
  });
});

test("the landing never asks for a deposit or a signature", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /deposit|connect|sign/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /deposit/i })).toHaveCount(0);
});
test("a claim that has not passed shows its downgrade text", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#built-on")).toContainText("Cross-chain deposits through NEAR Intents are in testing.");
  await expect(page.locator("#built-on")).not.toContainText(/^NEAR Intents$/);
});
test("the page still renders when every RPC is down", async ({ page, request }) => {
  await useScenario(request, "rpc-down");
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
test("the video slot shows a poster until the files exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero").getByText("Video coming soon")).toBeVisible();
});
