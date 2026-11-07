import { jsonLdScript, websiteJsonLd } from "@/lib/seo/site";

/**
 * JSON-LD must sit in the script body as raw JSON; React would escape quotes in a text child.
 * Takes no data from the chain or the API: only the static website object and the validated site origin.
 */
export function WebsiteJsonLd({ siteUrl, nonce }: { siteUrl: string; nonce: string | undefined }) {
  const json = jsonLdScript(websiteJsonLd(new URL(siteUrl).origin));
  // eslint-disable-next-line no-restricted-syntax -- static object, "<" escaped by jsonLdScript; no on-chain or API data
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: json }} />;
}
