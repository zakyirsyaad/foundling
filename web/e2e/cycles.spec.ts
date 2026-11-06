import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";

test.use({ javaScriptEnabled: false });

test("/app/cycles renders rows from the API without JavaScript", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.goto("/app/cycles");
  await expect(page.locator("tr[data-nonce='41']")).toContainText("Executed");
  await expect(page.locator("tr[data-nonce='40']")).toContainText("Hold");
  await expect(page.getByRole("list", { name: "Cycle map" }).getByRole("link")).toHaveCount(3);
});
test("the Hold filter shows only Hold rows", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.goto("/app/cycles?filter=hold");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("Hold");
});
test("with the API down the list comes from published_decision, labelled Partial", async ({ page, request }) => {
  await useScenario(request, "api-down");
  await page.goto("/app/cycles");
  await expect(page.getByText("Partial")).toBeVisible();
  await expect(page.locator("tr[data-nonce='41']")).toContainText('{"action":"buy","nonce":41}');
  await expect(page.locator("tr[data-nonce='40']")).toContainText("No decision to verify");
});
test("/app/cycles/41 shows the timeline, the proof and the replay status", async ({ page, request }) => {
  await useScenario(request, "normal");
  await page.goto("/app/cycles/41");
  await expect(page.getByRole("heading", { name: "Cycle 41" })).toBeVisible();
  await expect(page.locator("#timeline + ol")).toContainText("executed");
  await expect(page.getByText("Every limit held; the trade ran.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
});
