import { proofs } from "@foundling/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { failure, ok } from "../envelope";
import { type RouteDeps, nonceParam, tally } from "./shared";

/** Stored as JSON text (jsonb refuses the NUL in Intel collateral); served as JSON. */
function bundleOf(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function proofRoutes(deps: RouteDeps) {
  const r = new Hono();
  r.get("/:nonce", async (c) => {
    const nonce = nonceParam.parse(c.req.param("nonce"));
    const [p] = await deps.db.select().from(proofs).where(and(eq(proofs.vaultId, deps.vaultId), eq(proofs.nonce, nonce)));
    if (!p) return failure(c, 404, "no proof for this cycle");
    // The bundle is the one record the chain cannot give back; the live-proofs job archives it from here.
    return ok(c, { verifier: tally(p.verifier, p.verifierState), obs_recheck: tally(p.obsRecheck, p.obsState), replay: p.replay, bundle: bundleOf(p.bundle) });
  });
  return r;
}
