import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { config } from "@/config";
import { CycleDetail } from "@/features/cycles/CycleDetail";
import { createRpcClient } from "@/lib/chain/rpc";
import { getSnapshot } from "@/lib/chain/source";
import { createHistoryClient } from "@/lib/history/client";

export const metadata: Metadata = { title: "Cycle · Foundling" };
export const dynamic = "force-dynamic";

async function decisionOf(nonce: bigint): Promise<string | null> {
  try {
    return (await createRpcClient(config.rpcUrls).view(config.vaultId, "published_decision", { nonce: Number(nonce) }, (r) => z.string().nullable().parse(r))).value;
  } catch {
    return null;
  }
}

export default async function CyclePage({ params }: { params: Promise<{ nonce: string }> }) {
  const raw = (await params).nonce;
  if (!/^\d{1,20}$/.test(raw)) notFound();
  const nonce = BigInt(raw);
  const api = createHistoryClient(config.apiOrigin);
  const [row, proof, decision, snap] = await Promise.all([api.cycle(nonce), api.proof(nonce), decisionOf(nonce), getSnapshot("app")]);
  if (row.status !== "ok") {
    return (
      <div className="grid gap-4">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Cycle {raw}</h1>
        <p><span className="fm-status" data-tone="neutral">Partial</span> History is pending.</p>
        <p className="mono text-[13px] break-all">{decision ?? "No decision to verify"}</p>
      </div>
    );
  }
  const s = snap.ok ? snap.source.snapshot : null;
  return (
    <CycleDetail row={row.data} proof={proof.status === "ok" ? proof.data : null} decision={decision} revealAfter={s?.agent.revealAfter ?? 2n ** 63n} chainTime={s?.chainTimeSeconds ?? 0n} network={config.network} vaultId={config.vaultId} />
  );
}
