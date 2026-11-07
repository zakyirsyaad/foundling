import type { Metadata } from "next";

import { config } from "@/config";
import { ProofView } from "@/features/proof/ProofView";
import { getSnapshot } from "@/lib/chain/source";
import { proofFacts, unreadableFacts } from "@/lib/proof/facts";
import { readLocalProofs } from "@/lib/proof/local";
import { REPO_ROOT, attackRows } from "@/lib/proof/sample";

export const metadata: Metadata = { title: "Proof · Foundling" };
export const revalidate = 45;

export default async function ProofPage() {
  const result = await getSnapshot("landing");
  const source = result.ok ? result.source : null;
  const local = readLocalProofs(REPO_ROOT);
  const facts = source ? proofFacts(source, local, config.network) : unreadableFacts(config.vaultId, config.network);
  return <ProofView source={source} facts={facts} attacks={attackRows()} synthetic={local.synthetic} />;
}
