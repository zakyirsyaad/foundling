import { type Page, expect, test } from "@playwright/test";

import { PAGE_SEO } from "../content/seo";

/** The test build is testnet: everything must be crawlable for links but kept out of search. */
const INDEXED = [
  { route: "/", canonical: "/" },
  { route: "/proof", canonical: "/proof" },
  { route: "/trust", canonical: "/trust" },
  { route: "/terms", canonical: "/terms" },
  { route: "/app", canonical: "/app" },
  { route: "/app/cycles?filter=stopped", canonical: "/app/cycles" },
];

async function head(page: Page) {
  return page.evaluate(() => {
    const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") ?? null;
    return {
      // Chart SVGs carry their own <title>; only document titles count.
      titles: document.querySelectorAll("title:not(svg title)").length,
      title: document.title,
      description: meta('meta[name="description"]'),
      robots: meta('meta[name="robots"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      ogImage: meta('meta[property="og:image"]'),
      ogUrl: meta('meta[property="og:url"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
      icon: document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? null,
    };
  });
}

test("robots.txt keeps the testnet site out of search and lists no sitemap", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/User-Agent: \*\s+Disallow: \//i);
  expect(body).not.toMatch(/Sitemap:/i);
});

test("the testnet sitemap lists no pages", async ({ request }) => {
  const res = await request.get("/sitemap.xml");
  expect(res.status()).toBe(200);
  expect(await res.text()).not.toMatch(/<url>/);
});

for (const { route, canonical } of INDEXED) {
  test(`${route} has its own description, a canonical URL, share cards and noindex on testnet`, async ({ page }) => {
    await page.goto(route);
    const h = await head(page);
    expect(h.titles).toBe(1);
    expect(h.description?.length ?? 0).toBeGreaterThanOrEqual(110);
    expect(h.canonical && new URL(h.canonical).pathname).toBe(canonical);
    expect(h.ogUrl && new URL(h.ogUrl).pathname).toBe(canonical);
    expect(h.ogImage).toMatch(/\/opengraph-image/);
    expect(h.twitterCard).toBe("summary_large_image");
    expect(h.icon).toMatch(/\/icon/);
    expect(h.robots).toMatch(/noindex/);
  });
}

test("every indexed page has a different title and description", async ({ page }) => {
  const seen = { titles: new Set<string>(), descriptions: new Set<string>() };
  for (const { route } of INDEXED) {
    await page.goto(route);
    const h = await head(page);
    seen.titles.add(h.title);
    seen.descriptions.add(h.description ?? "");
  }
  expect(seen.titles.size).toBe(INDEXED.length);
  expect(seen.descriptions.size).toBe(INDEXED.length);
});

test("the wallet page and a cycle page are noindex but still followed", async ({ page }) => {
  await page.goto("/app/portfolio");
  expect((await head(page)).robots).toBe("noindex, follow");
  await page.goto("/app/cycles/41");
  const h = await head(page);
  expect(h.robots).toBe("noindex, follow");
  expect(h.title).toBe("Cycle 41 · Foundling");
  expect(h.description).toBe(PAGE_SEO.cycle.description);
});

test("the share image and icons are served", async ({ request }) => {
  for (const [path, type] of [["/opengraph-image", "image/png"], ["/apple-icon", "image/png"], ["/icon.svg", "image/svg+xml"]] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toContain(type);
  }
});

test("the home page describes the website as JSON-LD", async ({ page }) => {
  await page.goto("/");
  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  expect(JSON.parse(raw ?? "{}")).toMatchObject({ "@type": "WebSite", name: "Foundling" });
});

test("an unknown URL gets the site's 404 page with one title", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  const h = await head(page);
  expect(h.titles).toBe(1);
  expect(h.title).toBe("Page not found · Foundling");
  expect(h.robots).toMatch(/noindex/);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});
