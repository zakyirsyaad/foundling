import type { Metadata, MetadataRoute } from "next";

import type { DeploymentConfig } from "@/config/deployment";
import { GITHUB_URL } from "@/content/landing";
import { HOME_SEO, PAGE_SEO, type PageSeo, SITE } from "@/content/seo";

/**
 * app/opengraph-image.tsx, named here because a page that sets its own openGraph
 * loses the file-based image (Next merges metadata one key deep).
 */
const SHARE_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: `${SITE.name}, a USDC vault on NEAR` };

/** The pages worth finding in search, in sitemap order. */
const SITEMAP_PAGES: readonly PageSeo[] = [HOME_SEO.checked, PAGE_SEO.proof, PAGE_SEO.trust, PAGE_SEO.terms, PAGE_SEO.app, PAGE_SEO.cycles];

/**
 * Only the mainnet production site goes into search. Testnet carries the MOCK banner,
 * and a Vercel preview (VERCEL_ENV "preview" or "development") would compete with it.
 */
export function isIndexable(cfg: DeploymentConfig, vercelEnv: string | undefined): boolean {
  const production = vercelEnv === undefined || vercelEnv === "production";
  return cfg.network === "mainnet" && !cfg.testBuild && cfg.siteUrl !== null && production;
}

export function robotsFor(cfg: DeploymentConfig, vercelEnv: string | undefined): MetadataRoute.Robots {
  if (!isIndexable(cfg, vercelEnv)) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${cfg.siteUrl}/sitemap.xml` };
}

export function sitemapFor(cfg: DeploymentConfig, vercelEnv: string | undefined): MetadataRoute.Sitemap {
  if (!isIndexable(cfg, vercelEnv)) return [];
  return SITEMAP_PAGES.map((p) => ({ url: p.path === "/" ? `${cfg.siteUrl}` : `${cfg.siteUrl}${p.path}` }));
}

export function rootMetadata(cfg: DeploymentConfig, vercelEnv: string | undefined): Metadata {
  return {
    metadataBase: cfg.siteUrl ? new URL(cfg.siteUrl) : undefined,
    title: { default: SITE.title, template: `%s · ${SITE.name}` },
    description: SITE.description,
    applicationName: SITE.name,
    openGraph: { type: "website", siteName: SITE.name, title: SITE.title, description: SITE.description, locale: "en_US" },
    twitter: { card: "summary_large_image", title: SITE.title, description: SITE.description },
    robots: isIndexable(cfg, vercelEnv) ? undefined : { index: false, follow: false },
  };
}

/** A key set to undefined still replaces the parent's value, so noindex is added only when needed. */
const NOINDEX: Metadata = { robots: { index: false, follow: true } };

/**
 * Next merges metadata one key deep, so a page's openGraph replaces the root's whole object:
 * every field the root sets is repeated here. The root's robots (noindex off mainnet) stays
 * in force because indexed pages leave the key out.
 */
export function pageMetadata(p: PageSeo, title: Metadata["title"] = p.title): Metadata {
  return {
    ...(p.index === false ? NOINDEX : {}),
    title,
    description: p.description,
    alternates: { canonical: p.path },
    openGraph: { type: "website", siteName: SITE.name, title: p.title, description: p.description, url: p.path, locale: "en_US", images: [SHARE_IMAGE] },
    twitter: { card: "summary_large_image", title: p.title, description: p.description, images: [SHARE_IMAGE] },
  };
}

export function homeMetadata(downgraded: boolean): Metadata {
  const p = downgraded ? HOME_SEO.unchecked : HOME_SEO.checked;
  return pageMetadata(p, { absolute: p.title });
}

export function websiteJsonLd(siteUrl: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: siteUrl,
    description: SITE.description,
    publisher: { "@type": "Organization", name: SITE.name, url: siteUrl, sameAs: [GITHUB_URL] },
  };
}

/** JSON for a script tag: "<" is escaped so no value can end the tag early. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
