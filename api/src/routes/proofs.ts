import { proofs } from "@foundling/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { failure, ok } from "../envelope";
import { type RouteDeps, nonceParam, tally } from "./shared";

export function proofRoutes(deps: RouteDeps) {
  const r = new Hono();
  r.get("/:nonce", async (c) => {
    const nonce = nonceParam.parse(c.req.param("nonce"));
    const [p] = await deps.db.select().from(proofs).where(and(eq(proofs.vaultId, deps.vaultId), eq(proofs.nonce, nonce)));
    if (!p) return failure(c, 404, "no proof for this cycle");
    return ok(c, { verifier: tally(p.verifier, p.verifierState), obs_recheck: tally(p.obsRecheck, p.obsState), replay: p.replay });
  });
  return r;
}
