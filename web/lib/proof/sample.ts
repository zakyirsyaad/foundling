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

export interface AttackRow {
  name: string;
  expected: string;
  result: "Not run yet" | "Pass" | "Fail";
}

const NO_LINE = "See tools/attack-registry.json";

/** The English "Expected" line; an attack added before its line shows its reason codes, never the SPEC's Indonesian or a blank. */
export function expectedLine(a: { name: string; codes?: readonly string[] }): string {
  return ATTACK_EXPECTED[a.name] ?? (a.codes && a.codes.length > 0 ? a.codes.join(", ") : NO_LINE);
}

/** Attack Lab rows from the registry; a result only when `proofs/attack/<name>.json` exists. */
export function attackRows(): AttackRow[] {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tools", "attack-registry.json"), "utf8")) as { attacks: { name: string; codes?: string[] }[] };
    return registry.attacks.map((a) => {
      const expected = expectedLine(a);
      const file = path.join(REPO_ROOT, "proofs", "attack", `${a.name}.json`);
      if (!fs.existsSync(file)) return { name: a.name, expected, result: "Not run yet" as const };
      const r = JSON.parse(fs.readFileSync(file, "utf8")) as { result?: string };
      return { name: a.name, expected, result: r.result === "PASS" ? ("Pass" as const) : ("Fail" as const) };
    });
  } catch {
    return [];
  }
}
