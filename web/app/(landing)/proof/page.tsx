import type { Metadata } from "next";

import { config } from "@/config";
import { ProofView } from "@/features/proof/ProofView";
import { createRpcClient } from "@/lib/chain/rpc";
import type { VaultSnapshot } from "@/lib/chain/types";
import { readVaultSnapshot } from "@/lib/chain/vault";
import { proofFacts } from "@/lib/proof/facts";
import { proofSource, readLocalProofs } from "@/lib/proof/local";
import { REPO_ROOT, attackRows, loadSample } from "@/lib/proof/sample";

export const metadata: Metadata = { title: "Proof · Foundling" };
export const dynamic = "force-dynamic";

async function readLive(): Promise<VaultSnapshot | null> {
  try {
    return await readVaultSnapshot(createRpcClient(config.rpcUrls), config.vaultId);
  } catch {
    return null;
  }
}

export default async function ProofPage() {
  const sample = loadSample(config);
  const live = sample ? null : await readLive();
  const source = proofSource(config, live, sample);
  const local = readLocalProofs(REPO_ROOT);
  const facts = source ? proofFacts(source, local, config.network) : [];
  return <ProofView source={source} facts={facts} attacks={attackRows()} synthetic={local.synthetic} />;
}
