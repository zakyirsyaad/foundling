import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";
import { ROUTES } from "./routes";

const STATES = ["normal", "empty", "api-down", "rpc-down", "frozen", "halted", "stuck", "not-ready", "low-vault-near", "keeper-dead"] as const;

for (const scenario of STATES) {
  test(`every page renders in the ${scenario} state without console errors`, async ({ page, request }) => {
    await useScenario(request, scenario);
    for (const route of ROUTES) {
      const errors: string[] = [];
      const onConsole = (m: { type(): string; text(): string }) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${route}: ${m.text()}`);
      };
      page.on("console", onConsole);
      page.on("pageerror", (e) => errors.push(`${route}: ${e.message}`));
      const res = await page.goto(route);
      expect(res?.status(), route).toBeLessThan(500);
      await page.waitForTimeout(300);
      page.off("console", onConsole);
      expect(errors).toEqual([]);
    }
  });
}

test("the portfolio shows a skeleton while it reads the vault", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.route("**/rpc", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto("/app/portfolio");
  await expect(page.getByTestId("loading").first()).toBeVisible();
});
test("empty history still reads well", async ({ page, request }) => {
  await useScenario(request, "empty");
  await page.goto("/app/cycles");
  await expect(page.getByText(/No cycles yet/)).toBeVisible();
});
test("a quiet keeper shows No cycle since", async ({ page, request }) => {
  await useScenario(request, "keeper-dead");
  await page.goto("/app");
  await expect(page.getByTestId("last-cycle")).toContainText("No cycle since 2026-10-01");
});
test("low vault NEAR closes deposits with a reason", async ({ page, request }) => {
  await useScenario(request, "low-vault-near");
  await page.goto("/app");
  await expect(page.getByText("Vault NEAR below its reserve")).toBeVisible();
});
test("the testnet build shows the MOCK banner on every page", async ({ page }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.getByTestId("mock-banner"), route).toContainText("MOCK");
  }
});
