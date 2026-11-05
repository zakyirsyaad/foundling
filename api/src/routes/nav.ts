import { navPoints } from "@foundling/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../envelope";
import { MAX_LIMIT, type RouteDeps, iso } from "./shared";

const query = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() });

/** The newest points in the range (at most 100), oldest first. Raw values: the website computes the share price. */
export function navRoutes(deps: RouteDeps) {
  const r = new Hono();
  r.get("/", async (c) => {
    const q = query.parse(c.req.query());
    const found = await deps.db
      .select()
      .from(navPoints)
      .where(and(eq(navPoints.vaultId, deps.vaultId), q.from ? gte(navPoints.at, new Date(q.from)) : undefined, q.to ? lte(navPoints.at, new Date(q.to)) : undefined))
      .orderBy(desc(navPoints.nonce))
      .limit(MAX_LIMIT);
    return ok(
      c,
      found.reverse().map((n) => ({
        nonce: String(n.nonce),
        at: iso(n.at),
        book: { usdc: n.bookUsdc, wnear: n.bookWnear },
        total_shares: n.totalShares,
        oracle: n.oracleNear !== null && n.oracleUsdc !== null ? { near: n.oracleNear, usdc: n.oracleUsdc } : null,
      })),
    );
  });
  return r;
}
