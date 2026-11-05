/** One index round and the loop around it (WEBSITE §5 "Worker: putaran indeks"). */
import { type Db, cycles, events, navPoints, proofs, syncState } from "@foundling/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { type DerivedCycle, cycleEvents, deriveCycle } from "./derive";
import type { Fastnear } from "./fastnear";
import { readNav } from "./nav";
import { type ParsedEvent, parseTransaction, sortEvents } from "./parse";
import { type ArchivalRpc, ONE_HOUR_BLOCKS } from "./rpc";

export type Log = (message: string, fields?: Record<string, unknown>) => void;
export interface IndexDeps {
  db: Db;
  fastnear: Pick<Fastnear, "accountTxs" | "transactions">;
  rpc: Pick<ArchivalRpc, "viewAt" | "tip">;
  vaultId: string;
  log: Log;
}

/** Postgres allows 65535 bind parameters; events have 11 columns. */
const INSERT_BATCH = 500;
const DECISION = "decision";
const MAX_ERROR_LENGTH = 2000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Writes the heartbeat (creating the row on first run) and returns the stored position. */
async function heartbeat(db: Db, vaultId: string): Promise<bigint> {
  const [row] = await db
    .insert(syncState)
    .values({ vaultId, position: 0n, heartbeatAt: new Date() })
    .onConflictDoUpdate({ target: syncState.vaultId, set: { heartbeatAt: new Date() } })
    .returning({ position: syncState.position });
  return row!.position;
}

async function readWindow(deps: IndexDeps, position: bigint): Promise<{ parsed: ParsedEvent[]; top: bigint }> {
  const from = position > ONE_HOUR_BLOCKS ? position - ONE_HOUR_BLOCKS : 0n;
  const hashes = new Set<string>();
  let top = position;
  for await (const t of deps.fastnear.accountTxs(deps.vaultId, from)) {
    hashes.add(t.transaction_hash);
    top = maxBig(top, BigInt(t.tx_block_height));
  }
  const txs = hashes.size ? await deps.fastnear.transactions([...hashes]) : [];
  return { parsed: sortEvents(txs.flatMap((t) => parseTransaction(deps.vaultId, t))), top };
}

async function insertEvents(tx: Tx, parsed: ParsedEvent[]): Promise<{ nonce: bigint | null }[]> {
  const inserted: { nonce: bigint | null }[] = [];
  for (let i = 0; i < parsed.length; i += INSERT_BATCH) {
    const rows = parsed.slice(i, i + INSERT_BATCH);
    inserted.push(...(await tx.insert(events).values(rows).onConflictDoNothing().returning({ nonce: events.nonce })));
  }
  return inserted;
}

function fromRow(r: typeof events.$inferSelect): ParsedEvent {
  return { ...r, data: r.data as Record<string, unknown> };
}

/** Deletes and rewrites the cycle row for `nonce` from every stored event, and queues its proof once a decision exists. */
async function rederive(tx: Tx, vaultId: string, nonce: bigint): Promise<void> {
  const rows = await tx
    .select()
    .from(events)
    .where(and(eq(events.vaultId, vaultId), eq(events.nonce, nonce)))
    .orderBy(asc(events.blockHeight), asc(events.receiptIndex), asc(events.logIndex));
  const evs = cycleEvents(rows.map(fromRow));
  await tx.delete(cycles).where(and(eq(cycles.vaultId, vaultId), eq(cycles.nonce, nonce)));
  if (evs.length === 0) return;
  const c: DerivedCycle = deriveCycle(evs);
  await tx.insert(cycles).values({ vaultId, ...c, amountIn: c.amountIn?.toString() ?? null, amountOut: c.amountOut?.toString() ?? null });
  if (evs.some((e) => e.name === DECISION)) await tx.insert(proofs).values({ vaultId, nonce }).onConflictDoNothing();
}

/** Closed cycles without a nav point get one, read at the cycle's last block. A failed read is retried next round. */
async function recordNav(deps: IndexDeps): Promise<void> {
  const due = await deps.db
    .select({ nonce: cycles.nonce, lastBlock: cycles.lastBlock, finishedAt: cycles.finishedAt })
    .from(cycles)
    .leftJoin(navPoints, and(eq(navPoints.vaultId, cycles.vaultId), eq(navPoints.nonce, cycles.nonce)))
    .where(and(eq(cycles.vaultId, deps.vaultId), isNotNull(cycles.closing), isNull(navPoints.nonce)))
    .orderBy(asc(cycles.nonce));
  for (const c of due) {
    const nav = await readNav(deps.rpc, deps.vaultId, c.lastBlock);
    await deps.db
      .insert(navPoints)
      .values({
        vaultId: deps.vaultId, nonce: c.nonce, at: c.finishedAt!, blockHeight: c.lastBlock,
        bookUsdc: nav.bookUsdc.toString(), bookWnear: nav.bookWnear.toString(), totalShares: nav.totalShares.toString(),
        oracleNear: nav.oracleNear?.toString() ?? null, oracleUsdc: nav.oracleUsdc?.toString() ?? null,
      })
      .onConflictDoNothing();
  }
}

/** The innermost cause names the real failure; a wrapped query error otherwise carries every bound parameter. */
export function describeError(e: unknown): string {
  let root = e;
  while (root instanceof Error && root.cause instanceof Error) root = root.cause;
  const text = root instanceof Error ? `${root.name}: ${root.message}` : String(root);
  return text.slice(0, MAX_ERROR_LENGTH);
}

export class IndexRoundError extends Error {
  override name = "IndexRoundError";
}

/** One round. Any failure lands in `sync_state.last_error`, leaves the position where it was, and is rethrown. */
export async function indexOnce(deps: IndexDeps): Promise<{ stored: number; position: bigint }> {
  const { db, vaultId } = deps;
  const position = await heartbeat(db, vaultId);
  try {
    const tip = await deps.rpc.tip();
    await db.update(syncState).set({ tip }).where(eq(syncState.vaultId, vaultId));
    const { parsed, top } = await readWindow(deps, position);
    const stored = await db.transaction(async (tx) => {
      const inserted = await insertEvents(tx, parsed);
      await tx.update(syncState).set({ position: top }).where(eq(syncState.vaultId, vaultId));
      const touched = [...new Set(inserted.flatMap((r) => (r.nonce === null ? [] : [r.nonce])))];
      for (const nonce of touched) await rederive(tx, vaultId, nonce);
      return inserted.length;
    });
    await recordNav(deps);
    await db.update(syncState).set({ lastError: null }).where(eq(syncState.vaultId, vaultId));
    if (stored) deps.log("indexed", { vaultId, stored, position: top.toString() });
    return { stored, position: top };
  } catch (e) {
    const message = describeError(e);
    await db.update(syncState).set({ lastError: message }).where(eq(syncState.vaultId, vaultId));
    throw new IndexRoundError(message, { cause: e });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIndexLoop(deps: IndexDeps, intervalMs = 30_000): Promise<never> {
  for (;;) {
    try {
      await indexOnce(deps);
    } catch (e) {
      deps.log("index round failed", { vaultId: deps.vaultId, error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(intervalMs);
  }
}

/** Holds a session-level advisory lock for the vault while `fn` runs, so a redeploy never runs two workers. */
export async function withVaultLock<T>(db: Db, vaultId: string, fn: () => Promise<T>): Promise<T | "locked"> {
  const client = await db.$client.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [vaultId]);
    if (!rows[0]?.ok) return "locked";
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [vaultId]);
    }
  } finally {
    client.release();
  }
}
