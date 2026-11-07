import type { Metadata } from "next";

import { TrustView } from "@/features/trust/TrustView";
import { getSnapshot } from "@/lib/chain/source";
import { PAGE_SEO } from "@/content/seo";
import { pageMetadata } from "@/lib/seo/site";

export const metadata: Metadata = pageMetadata(PAGE_SEO.trust);
export const revalidate = 45;

export default async function TrustPage() {
  const r = await getSnapshot("landing");
  return <TrustView snapshot={r.ok ? r.source.snapshot : null} label={r.ok && r.source.kind === "sample" ? r.source.label : null} />;
}
