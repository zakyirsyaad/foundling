import { expect, test } from "@playwright/test";

import { ROUTES } from "./routes";

for (const route of ROUTES) {
  test(`${route} sends a nonce CSP and logs no CSP violation`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
    });
    const res = await page.goto(route);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    await page.waitForTimeout(1500);
    expect(violations).toEqual([]);
  });
}
