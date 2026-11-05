import { cycles, events, proofs } from "@foundling/db";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cursorSchema, digits, encodeCursor } from "../cursor";
import { failure, ok } from "../envelope";
import { type RouteDeps, iso, limitSchema, nonceParam, str, tally } from "./shared";

/** Same buckets as web/lib/cycles/outcome.ts filterCycles. */
const FILTERS = { executed: "executed", hold: "hold" } as const;
const listQuery = z.object({
  filter: z.enum(["all", "executed", "hold", "other"]).default("all"),
  cursor: cursorSchema(z.object({ n: digits })).optional(),
  limit: limitSchema,
});
/** Account events that carry a cycle nonce but are not part of the cycle (indexer/src/derive.ts). */
const NOT_CYCLE_EVENTS = ["claimed"];

type CycleRecord = typeof cycles.$inferSelect;

function filterWhere(filter: z.infer<typeof listQuery>["filter"]): SQL | undefined {
  if (filter === "executed" || filter === "hold") return eq(cycles.closing, FILTERS[filter]);
  if (filter === "other") return or(isNull(cycles.closing), notInArray(cycles.closing, Object.values(FILTERS)));
  return undefined;
}

async function rows(deps: RouteDeps, list: CycleRecord[]) {
  if (list.length === 0) return [];
  const nonces = list.map((c) => c.nonce);
  const [evs, prs] = await Promise.all([
    deps.db
      .select({ nonce: events.nonce, name: events.name, data: events.data, txHash: events.txHash })
      .from(events)
      .where(and(eq(events.vaultId, deps.vaultId), inArray(events.nonce, nonces), notInArray(events.name, NOT_CYCLE_EVENTS)))
      .orderBy(asc(events.blockHeight), asc(events.receiptIndex), asc(events.logIndex)),
    deps.db.select().from(proofs).where(and(eq(proofs.vaultId, deps.vaultId), inArray(proofs.nonce, nonces))),
  ]);
  return list.map((c) => {
    const own = evs.filter((e) => e.nonce === c.nonce);
    const proof = prs.find((p) => p.nonce === c.nonce);
    const closingTx = c.closing ? own.findLast((e) => e.name === c.closing)?.txHash ?? null : null;
    return {
      nonce: String(c.nonce),
      started_at: iso(c.startedAt),
      finished_at: iso(c.finishedAt),
      events: own.map((e) => {
        const code = (e.data as Record<string, unknown>).code;
        return typeof code === "string" ? { name: e.name, code } : { name: e.name };
      }),
      amount_in: str(c.amountIn),
      amount_out: str(c.amountOut),
      tx_hashes: [...new Set([c.triggerTx, c.decisionTx, closingTx].filter((h): h is string => h !== null))],
      verifier: proof ? tally(proof.verifier, proof.verifierState) : null,
      obs_recheck: proof ? tally(proof.obsRecheck, proof.obsState) : null,
    };
  });
}

export function cycleRoutes(deps: RouteDeps) {
  const r = new Hono();

  r.get("/", async (c) => {
    const q = listQuery.parse(c.req.query());
    const where = and(eq(cycles.vaultId, deps.vaultId), q.cursor ? lt(cycles.nonce, BigInt(q.cursor.n)) : undefined, filterWhere(q.filter));
    const found = await deps.db.select().from(cycles).where(where).orderBy(desc(cycles.nonce)).limit(q.limit + 1);
    const page = found.slice(0, q.limit);
    const next = found.length > q.limit ? encodeCursor({ n: String(page[page.length - 1]!.nonce) }) : null;
    return ok(c, await rows(deps, page), next);
  });

  r.get("/:nonce", async (c) => {
    const nonce = nonceParam.parse(c.req.param("nonce"));
    const found = await deps.db.select().from(cycles).where(and(eq(cycles.vaultId, deps.vaultId), eq(cycles.nonce, nonce)));
    if (found.length === 0) return failure(c, 404, "no such cycle");
    return ok(c, (await rows(deps, found))[0]);
  });

  return r;
}

