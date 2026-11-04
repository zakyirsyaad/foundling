import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { DeploymentConfig } from "@/config/deployment";
import type { VaultSnapshot } from "@/lib/chain/types";

export interface LocalProof {
  synthetic: boolean;
  commitment: { vault: string; wasmHash: string; commitment: string } | null;
  accessKeys: number | null;
}
export type SnapshotSource =
  | { kind: "live"; snapshot: VaultSnapshot }
  | { kind: "sample"; label: string; snapshot: VaultSnapshot };

export const SAMPLE_LABEL = "Testnet rehearsal vault (m12)";

const commitmentFile = z.object({ synthetic: z.boolean().optional(), vault: z.string(), wasm_hash: z.string(), commitment: z.string() }).loose();
const keysFile = z.object({ synthetic: z.boolean().optional(), response: z.object({ result: z.object({ keys: z.array(z.unknown()) }).loose() }).loose() }).loose();

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Reads `proofs/` at build time. A missing or malformed file reads as absent, never as proof. */
export function readLocalProofs(repoRoot: string): LocalProof {
  const c = commitmentFile.safeParse(readJson(path.join(repoRoot, "proofs", "commitment.json")));
  const k = keysFile.safeParse(readJson(path.join(repoRoot, "proofs", "access_keys.json")));
  return {
    synthetic: (c.success && c.data.synthetic === true) || (k.success && k.data.synthetic === true),
    commitment: c.success ? { vault: c.data.vault, wasmHash: c.data.wasm_hash, commitment: c.data.commitment } : null,
    accessKeys: k.success ? k.data.response.result.keys.length : null,
  };
}

/** Before the final vault, the labelled m12 sample stands in for live data. */
export function proofSource(cfg: DeploymentConfig, live: VaultSnapshot | null, sample: VaultSnapshot | null): SnapshotSource | null {
  if (cfg.sample === "m12" && sample) return { kind: "sample", label: SAMPLE_LABEL, snapshot: sample };
  return live ? { kind: "live", snapshot: live } : null;
}
