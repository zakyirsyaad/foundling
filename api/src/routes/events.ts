import { events } from "@foundling/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cursorSchema, digits, encodeCursor } from "../cursor";
import { ok } from "../envelope";
import { type RouteDeps, iso, limitSchema, str } from "./shared";

const query = z.object({
  name: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  cursor: cursorSchema(z.object({ b: digits, r: digits, l: digits })).optional(),
  limit: limitSchema,
});

/** Vault activity, newest first. Not a full history: cancel_deposit and withdraw_claimable emit no event (WEBSITE §5). */
export function eventRoutes(deps: RouteDeps) {
  const r = new Hono();
  r.get("/", async (c) => {
    const q = query.parse(c.req.query());
    const before = q.cursor
      ? sql`(${events.blockHeight}, ${events.receiptIndex}, ${events.logIndex}) < (${BigInt(q.cursor.b)}, ${Number(q.cursor.r)}, ${Number(q.cursor.l)})`
      : undefined;
    const found = await deps.db
      .select()
      .from(events)
      .where(and(eq(events.vaultId, deps.vaultId), q.name ? eq(events.name, q.name) : undefined, before))
      .orderBy(desc(events.blockHeight), desc(events.receiptIndex), desc(events.logIndex))
      .limit(q.limit + 1);
    const page = found.slice(0, q.limit);
    const last = page[page.length - 1];
    const next = found.length > q.limit && last ? encodeCursor({ b: String(last.blockHeight), r: String(last.receiptIndex), l: String(last.logIndex) }) : null;
    return ok(
      c,
      page.map((e) => ({
        name: e.name, nonce: str(e.nonce), account: e.account, tx_hash: e.txHash, receipt_id: e.receiptId, log_index: e.logIndex,
        block_height: String(e.blockHeight), block_time: iso(e.blockTime), data: e.data,
      })),
      next,
    );
  });
  return r;
}
