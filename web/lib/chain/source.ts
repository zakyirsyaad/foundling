import "server-only";

import { config } from "@/config";
import { type SnapshotSource, proofSource } from "@/lib/proof/local";
import { loadSample } from "@/lib/proof/sample";
import { createTtlCache } from "./cache";
import { createRpcClient } from "./rpc";
import type { VaultSnapshot } from "./types";
import { readVaultSnapshot } from "./vault";

export type SnapshotResult = { ok: true; source: SnapshotSource } | { ok: false; reason: "unreadable" };

const MS = 1000;
const caches = {
  landing: createTtlCache<VaultSnapshot>(config.landingCacheSeconds * MS),
  app: createTtlCache<VaultSnapshot>(config.appCacheSeconds * MS),
};

/** The vault for a server render: the labelled sample when it is on, else a cached RPC read. Never throws. */
export async function getSnapshot(scope: "landing" | "app"): Promise<SnapshotResult> {
  const sample = scope === "landing" ? loadSample(config) : null;
  let live: VaultSnapshot | null = null;
  if (!sample) {
    try {
      live = await caches[scope].get(config.vaultId, () => readVaultSnapshot(createRpcClient(config.rpcUrls), config.vaultId));
    } catch {
      live = null;
    }
  }
  const source = proofSource(config, live, sample);
  return source ? { ok: true, source } : { ok: false, reason: "unreadable" };
}
