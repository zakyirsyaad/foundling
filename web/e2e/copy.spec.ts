import { type Page, expect, test } from "@playwright/test";

import { findForbidden } from "../content/forbidden";
import { useScenario } from "./helpers";
import { ROUTES, SCENARIOS } from "./routes";

async function visibleCopy(page: Page): Promise<{ text: string; exempt: number }> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    const exempt = clone.querySelectorAll('[data-copy-exempt="not-claimed"]');
    exempt.forEach((e) => e.remove());
    clone.querySelectorAll("script, style, noscript").forEach((e) => e.remove());
    return { text: clone.textContent ?? "", exempt: exempt.length };
  });
}

for (const scenario of SCENARIOS) {
  for (const route of ROUTES) {
    test(`no forbidden words on ${route} (${scenario})`, async ({ page, request }) => {
      await useScenario(request, scenario);
      await page.goto(route);
      const { text, exempt } = await visibleCopy(page);
      expect(findForbidden(text)).toEqual([]);
      expect(exempt).toBe(route === "/" ? 1 : 0);
    });
  }
}

test("the check catches a forbidden word", async ({ page }) => {
  await page.goto("/copy-fixture-test");
  const { text } = await visibleCopy(page);
  expect(findForbidden(text)).toEqual(["APY"]);
});
