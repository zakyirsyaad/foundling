import { syncState } from "@foundling/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { failure, ok } from "../envelope";
import type { RouteDeps } from "./shared";

export function statusRoutes(deps: RouteDeps) {
  const r = new Hono();
  r.get("/", async (c) => {
    const [s] = await deps.db.select().from(syncState).where(eq(syncState.vaultId, deps.vaultId));
    if (!s?.heartbeatAt) return failure(c, 404, "the worker has not reported yet");
    // Lag is how far the chain has moved since the last round that succeeded, not since the vault's last tx:
    // an idle vault is not behind, and rounds that keep failing are.
    const scanned = s.scannedTip ?? s.position;
    const lag = s.tip !== null && s.tip > scanned ? s.tip - scanned : 0n;
    return ok(c, { position: String(s.position), heartbeat_at: s.heartbeatAt.toISOString(), tip_lag: String(lag), indexed_at: s.indexedAt?.toISOString() ?? null });
  });
  return r;
}
