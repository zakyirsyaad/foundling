import fs from "node:fs";
import path from "node:path";

import type { DeploymentConfig } from "@/config/deployment";
import { ATTACK_EXPECTED } from "@/content/attacks";
import { deserializeSnapshot } from "@/lib/chain/serialize";
import type { VaultSnapshot } from "@/lib/chain/types";

export const WEB_ROOT = process.cwd();
export const REPO_ROOT = path.resolve(WEB_ROOT, "..");

/** The labelled m12 snapshot, read on the server. Absent when the sample is off or the file is missing. */
export function loadSample(cfg: DeploymentConfig): VaultSnapshot | null {
  if (cfg.sample !== "m12") return null;
  try {
    return deserializeSnapshot(fs.readFileSync(path.join(WEB_ROOT, "fixtures", "m12.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Pass and Fail come from a committed proof; the other two say why there is no result to show. */
export type AttackResult = "Pass" | "Fail" | "No proof committed" | "Proof unreadable";

export interface AttackRow {
  name: string;
  expected: string;
  result: AttackResult;
  /** The proof's `vault_wasm_sha256`: the vault build the attack ran on, which may not be the deployed code. */
  build: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const NO_LINE = "See tools/attack-registry.json";

/** The English "Expected" line; an attack added before its line shows its reason codes, never the SPEC's Indonesian or a blank. */
export function expectedLine(a: { name: string; codes?: readonly string[] }): string {
  return ATTACK_EXPECTED[a.name] ?? (a.codes && a.codes.length > 0 ? a.codes.join(", ") : NO_LINE);
}

/** Written by `make attack-proofs` from a run on the reproducible vault build; claims.json points here too. */
export const ATTACK_PROOF_DIR = path.join(REPO_ROOT, "proofs", "attack", "reproducible");

/** One proof file. A broken file marks only its own row, so the rest of the table still shows. */
function readProof(file: string): Pick<AttackRow, "result" | "build"> {
  if (!fs.existsSync(file)) return { result: "No proof committed", build: null };
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as { result?: unknown; vault_wasm_sha256?: unknown };
    const build = typeof r.vault_wasm_sha256 === "string" && SHA256_HEX.test(r.vault_wasm_sha256) ? r.vault_wasm_sha256 : null;
    return { result: r.result === "PASS" ? "Pass" : "Fail", build };
  } catch {
    return { result: "Proof unreadable", build: null };
  }
}

/** Attack Lab rows from the registry; a result only when `<dir>/<name>.json` exists. */
export function attackRows(dir: string = ATTACK_PROOF_DIR): AttackRow[] {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tools", "attack-registry.json"), "utf8")) as { attacks: { name: string; codes?: string[] }[] };
    return registry.attacks.map((a) => ({ name: a.name, expected: expectedLine(a), ...readProof(path.join(dir, `${a.name}.json`)) }));
  } catch {
    return [];
  }
}

/**
 * The vault builds the shown results ran on, and whether the vault's own code is that build.
 * matchesLive is null when the code hash is unknown or no proof names a build.
 */
export function attackBuilds(rows: readonly AttackRow[], liveHex: string | null): { builds: string[]; matchesLive: boolean | null } {
  const builds = [...new Set(rows.map((r) => r.build).filter((b): b is string => b !== null))];
  if (liveHex === null || builds.length === 0) return { builds, matchesLive: null };
  return { builds, matchesLive: builds.length === 1 && builds[0] === liveHex };
}
