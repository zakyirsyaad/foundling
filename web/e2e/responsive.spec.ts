import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";
import { ROUTES } from "./routes";

test.use({ viewport: { width: 375, height: 812 } });

test("no page scrolls sideways at 375 px", async ({ page, request }) => {
  await useScenario(request, "normal");
  const wide: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) wide.push(`${route}: ${overflow}px`);
  }
  expect(wide).toEqual([]);
});
