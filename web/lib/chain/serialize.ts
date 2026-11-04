import type { VaultSnapshot } from "./types";

const TAG = "$bigint";

/** JSON for a snapshot: every bigint becomes {"$bigint": "<decimal>"} so it reads back exactly. */
export function serializeSnapshot(s: VaultSnapshot): string {
  return JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? { [TAG]: v.toString() } : v), 2);
}

export function deserializeSnapshot(json: string): VaultSnapshot {
  return JSON.parse(json, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v[TAG] === "string") return BigInt(v[TAG]);
    return v;
  }) as VaultSnapshot;
}
