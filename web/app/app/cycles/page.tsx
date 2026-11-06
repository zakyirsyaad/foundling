import type { Metadata } from "next";

import { config } from "@/config";
import { CycleFilterBar, CycleMap, CycleTable, PartialTable } from "@/features/cycles/CycleList";
import { createRpcClient } from "@/lib/chain/rpc";
import { getSnapshot } from "@/lib/chain/source";
import { fallbackCycles, historyPendingText } from "@/lib/cycles/fallback";
import { filterCycles } from "@/lib/cycles/outcome";
import { type CycleFilter, createHistoryClient } from "@/lib/history/client";

export const metadata: Metadata = { title: "Cycles · Foundling" };
export const dynamic = "force-dynamic";

const FILTERS = new Set<CycleFilter>(["all", "executed", "hold", "other"]);

export default async function CyclesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const raw = (await searchParams).filter;
  const filter: CycleFilter = raw && FILTERS.has(raw as CycleFilter) ? (raw as CycleFilter) : "all";
  const history = await createHistoryClient(config.apiOrigin).cycles({ filter });
  if (history.status === "ok") {
    const rows = filterCycles(history.data, filter);
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Cycles</h1>
        <CycleFilterBar active={filter} />
        <CycleMap rows={rows} />
        <CycleTable rows={rows} />
      </div>
    );
  }
  const snap = await getSnapshot("app");
  let partial = null;
  if (snap.ok) {
    try {
      partial = await fallbackCycles(createRpcClient(config.rpcUrls), config.vaultId, snap.source.snapshot.lastNonce);
    } catch {
      partial = null;
    }
  }
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Cycles</h1>
      {partial ? <PartialTable rows={partial.rows} /> : <p>{historyPendingText(snap.ok)}</p>}
    </div>
  );
}
