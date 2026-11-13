import type { Metadata } from "next";
import { headers } from "next/headers";

import { config } from "@/config";
import { Home } from "@/features/landing/Home";
import { WebsiteJsonLd } from "@/features/landing/WebsiteJsonLd";
import { getSnapshot } from "@/lib/chain/source";
import { claimText } from "@/lib/claims";
import { webClaims } from "@/lib/claims-source";
import { keysLine } from "@/lib/proof/keysLine";
import { homeMetadata } from "@/lib/seo/site";

export const revalidate = 45;

export function generateMetadata(): Metadata {
  return homeMetadata(claimText(webClaims(config), "born-without-keys").downgraded);
}

export default async function HomePage() {
  const [result, nonce] = await Promise.all([getSnapshot("landing"), headers().then((h) => h.get("x-nonce") ?? undefined)]);
  return (
    <>
      {config.siteUrl ? <WebsiteJsonLd siteUrl={config.siteUrl} nonce={nonce} /> : null}
      <Home claims={webClaims(config)} keysLine={keysLine(result.ok ? result.source : null, config.network)} source={result.ok ? result.source : null} />
    </>
  );
}
