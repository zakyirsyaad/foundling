import type { Metadata } from "next";

import { config } from "@/config";
import { Overview } from "@/features/vault/Overview";
import { getSnapshot } from "@/lib/chain/source";
import { createHistoryClient } from "@/lib/history/client";

export const metadata: Metadata = { title: "Vault · Foundling" };
export const dynamic = "force-dynamic";

export default async function AppOverview() {
  const [r, nav] = await Promise.all([getSnapshot("app"), createHistoryClient(config.apiOrigin).nav({})]);
  return <Overview initial={r.ok ? r.source.snapshot : null} nav={nav} />;
}
