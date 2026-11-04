import type { Metadata } from "next";

import { TrustView } from "@/features/trust/TrustView";
import { getSnapshot } from "@/lib/chain/source";

export const metadata: Metadata = { title: "Trust · Foundling" };
export const revalidate = 45;

export default async function TrustPage() {
  const r = await getSnapshot("landing");
  return <TrustView snapshot={r.ok ? r.source.snapshot : null} label={r.ok && r.source.kind === "sample" ? r.source.label : null} />;
}
