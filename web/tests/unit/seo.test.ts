import { loadConfig } from "@/config/deployment";
import { findForbidden } from "@/content/forbidden";
import { HOME_SEO, PAGE_SEO } from "@/content/seo";
import { homeMetadata, isIndexable, jsonLdScript, pageMetadata, robotsFor, rootMetadata, sitemapFor, websiteJsonLd } from "@/lib/seo/site";

const mainnet = loadConfig({
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_VAULT_ID: "foundling-vault.near",
  NEXT_PUBLIC_RPC_URLS: "https://rpc.mainnet.fastnear.com",
  NEXT_PUBLIC_SITE_URL: "https://foundling.example",
});
const testnet = loadConfig({
  NEXT_PUBLIC_NETWORK: "testnet",
  NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet",
  NEXT_PUBLIC_RPC_URLS: "https://rpc.testnet.fastnear.com",
  NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet",
  NEXT_PUBLIC_WNEAR_ID: "wnear.foundling.testnet",
  NEXT_PUBLIC_SITE_URL: "https://testnet.foundling.example",
});

describe("who gets indexed", () => {
  test("only the mainnet production deploy with a site URL is indexable", () => {
    expect(isIndexable(mainnet, "production")).toBe(true);
    expect(isIndexable(mainnet, undefined)).toBe(true);
  });
  test("testnet, Vercel previews, test builds and a missing site URL are not", () => {
    expect(isIndexable(testnet, "production")).toBe(false);
    expect(isIndexable(mainnet, "preview")).toBe(false);
    expect(isIndexable(mainnet, "development")).toBe(false);
    expect(isIndexable({ ...mainnet, testBuild: true }, "production")).toBe(false);
    expect(isIndexable({ ...mainnet, siteUrl: null }, "production")).toBe(false);
  });
});

describe("robots.txt and the sitemap", () => {
  test("a non-indexable deploy blocks every crawler and lists no pages", () => {
    expect(robotsFor(testnet, "production")).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    expect(sitemapFor(testnet, "production")).toEqual([]);
  });
  test("the mainnet deploy allows crawling and points at its sitemap", () => {
    expect(robotsFor(mainnet, "production")).toEqual({ rules: { userAgent: "*", allow: "/" }, sitemap: "https://foundling.example/sitemap.xml" });
  });
  test("the sitemap lists the public pages as absolute URLs, not the wallet or per-cycle pages", () => {
    const urls = sitemapFor(mainnet, "production").map((e) => e.url);
    expect(urls).toEqual(["/", "/proof", "/trust", "/terms", "/app", "/app/cycles"].map((p) => `https://foundling.example${p === "/" ? "" : p}`));
  });
});

describe("metadata", () => {
  test("the root sets the base URL, a title template and noindex off mainnet", () => {
    const m = rootMetadata(testnet, "production");
    expect(m.metadataBase?.toString()).toBe("https://testnet.foundling.example/");
    expect(m.title).toMatchObject({ template: "%s · Foundling" });
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.twitter).toMatchObject({ card: "summary_large_image" });
  });
  test("the mainnet root leaves indexing on", () => {
    expect(rootMetadata(mainnet, "production").robots).toBeUndefined();
  });
  test("a page gets its own description, a canonical path and matching Open Graph fields", () => {
    const m = pageMetadata(PAGE_SEO.proof);
    expect(m.description).toBe(PAGE_SEO.proof.description);
    expect(m.alternates).toEqual({ canonical: "/proof" });
    expect(m.openGraph).toMatchObject({ url: "/proof", title: PAGE_SEO.proof.title, siteName: "Foundling", type: "website" });
    // Even an undefined value would replace the root's testnet noindex, so the key must be absent.
    expect(m).not.toHaveProperty("robots");
  });
  test("a page's own Open Graph and Twitter fields still carry the share image", () => {
    const m = pageMetadata(PAGE_SEO.trust);
    expect(m.openGraph).toMatchObject({ images: [{ url: "/opengraph-image", width: 1200, height: 630 }] });
    expect(m.twitter).toMatchObject({ images: [{ url: "/opengraph-image" }] });
  });
  test("the wallet page and per-cycle pages are noindex", () => {
    expect(pageMetadata(PAGE_SEO.portfolio).robots).toEqual({ index: false, follow: true });
    expect(pageMetadata({ ...PAGE_SEO.cycle, path: "/app/cycles/7" }).robots).toEqual({ index: false, follow: true });
  });
  test("the home title only says born without keys once that claim passes", () => {
    expect((homeMetadata(false).title as { absolute: string }).absolute).toMatch(/ born without keys/);
    expect((homeMetadata(false).title as { absolute: string }).absolute).not.toMatch(/meant to be/);
    expect((homeMetadata(true).title as { absolute: string }).absolute).toMatch(/meant to be born without keys/);
    expect(homeMetadata(true).description).toMatch(/meant to be/);
  });
});

describe("search copy", () => {
  const indexed = [HOME_SEO.checked, HOME_SEO.unchecked, PAGE_SEO.proof, PAGE_SEO.trust, PAGE_SEO.terms, PAGE_SEO.app, PAGE_SEO.cycles];
  test("indexed pages have a 110 to 160 character description, all different", () => {
    for (const p of indexed) expect(p.description.length, p.description).toBeGreaterThanOrEqual(110);
    for (const p of indexed) expect(p.description.length, p.description).toBeLessThanOrEqual(160);
    expect(new Set(indexed.map((p) => p.description)).size).toBe(indexed.length);
  });
  test("titles stay within 60 characters with the brand suffix", () => {
    for (const p of [PAGE_SEO.proof, PAGE_SEO.trust, PAGE_SEO.terms, PAGE_SEO.app, PAGE_SEO.cycles]) expect(`${p.title} · Foundling`.length, p.title).toBeLessThanOrEqual(60);
    for (const p of [HOME_SEO.checked, HOME_SEO.unchecked]) expect(p.title.length, p.title).toBeLessThanOrEqual(65);
  });
  test("no search copy uses a forbidden word", () => {
    const all = [...Object.values(PAGE_SEO), HOME_SEO.checked, HOME_SEO.unchecked].flatMap((p) => [p.title, p.description]);
    expect(findForbidden(all.join(" \n "))).toEqual([]);
  });
});

describe("structured data", () => {
  test("the home page describes the website and its publisher", () => {
    const ld = websiteJsonLd("https://foundling.example");
    expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "WebSite", url: "https://foundling.example", publisher: { "@type": "Organization", name: "Foundling" } });
  });
  test("the script body cannot close its own tag", () => {
    expect(jsonLdScript({ name: "</script><script>x()</script>" })).not.toMatch(/<\/script/i);
    expect(JSON.parse(jsonLdScript({ name: "</script>" }))).toEqual({ name: "</script>" });
  });
});
