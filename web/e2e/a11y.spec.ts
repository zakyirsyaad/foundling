import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { useScenario } from "./helpers";
import { ROUTES } from "./routes";

for (const scheme of ["light", "dark"] as const) {
  test(`no serious accessibility issues in ${scheme} mode`, async ({ page, request }) => {
    await useScenario(request, "normal");
    await page.emulateMedia({ colorScheme: scheme });
    const problems: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForTimeout(300);
      const { violations } = await new AxeBuilder({ page }).analyze();
      for (const v of violations.filter((x) => x.impact === "serious" || x.impact === "critical")) problems.push(`${route} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    }
    expect(problems).toEqual([]);
  });
}
