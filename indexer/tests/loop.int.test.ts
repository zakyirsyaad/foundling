import { db as connect, migrate } from "@foundling/db";
import { lockTestDb, resetDb, sql } from "../../packages/db/tests/helpers";
import { indexOnce, rederiveAll, withVaultLock } from "../src/loop";
import type { FastnearTx } from "../src/parse";
import { fakeFastnear, fakeRpc, fixture, log } from "./support";

const url = process.env.DATABASE_URL!;
const { db, pool } = connect(url, 3);
let lock: Awaited<ReturnType<typeof lockTestDb>>;
beforeAll(async () => {
  lock = await lockTestDb(url);
});
afterAll(async () => {
  await pool.end();
  await lock.release();
});
beforeEach(async () => {
  await resetDb(url);
  await migrate(url);
});

const count = async (table: string) => Number((await sql<{ n: string }>(url, `select count(*) as n from ${table}`))[0]!.n);

test("indexing m12 twice stores each event once", async () => {
  const m12 = fixture("m12");
  const deps = { db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: m12.vault, log };
  const first = await indexOnce(deps);
  const total = Object.values(m12.expected).reduce((a, b) => a + b, 0);
  expect(first.stored).toBe(total);
  const second = await indexOnce(deps);
  expect(second.stored).toBe(0);
  expect(await count("events")).toBe(total);
  const byName = await sql<{ name: string; n: string }>(url, "select name, count(*) as n from events group by name");
  expect(Object.fromEntries(byName.map((r) => [r.name, Number(r.n)]))).toEqual(m12.expected);
  const state = (await sql<{ position: string; tip: string; heartbeat_at: Date; last_error: string | null }>(url, "select * from sync_state"))[0]!;
  expect(BigInt(state.position)).toBe(second.position);
  expect(state.tip).toBe("300000000");
  expect(state.heartbeat_at).toBeInstanceOf(Date);
  expect(state.last_error).toBeNull();
});

test("a failure after the events insert rolls the whole round back", async () => {
  const m12 = fixture("m12");
  await sql(url, `create function boom() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
                  create trigger boom before insert on cycles for each row execute function boom();`);
  const deps = { db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: m12.vault, log };
  await expect(indexOnce(deps)).rejects.toThrow(/injected failure/);
  expect(await count("events")).toBe(0);
  const state = (await sql<{ position: string; last_error: string; heartbeat_at: Date }>(url, "select * from sync_state"))[0]!;
  expect(state.position).toBe("0");
  expect(state.last_error).toMatch(/injected failure/);
  expect(state.heartbeat_at).toBeInstanceOf(Date);

  await sql(url, "drop trigger boom on cycles");
  await indexOnce(deps);
  expect(await count("events")).toBeGreaterThan(0);
  expect((await sql<{ last_error: string | null }>(url, "select last_error from sync_state"))[0]!.last_error).toBeNull();
});

test("a second worker for the same vault is refused the lock", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const first = withVaultLock(db, "v.testnet", () => held.then(() => "done"));
  await new Promise((r) => setTimeout(r, 50));
  await expect(withVaultLock(db, "v.testnet", async () => "second")).resolves.toBe("locked");
  await expect(withVaultLock(db, "other.testnet", async () => "free")).resolves.toBe("free");
  release();
  await expect(first).resolves.toBe("done");
  await expect(withVaultLock(db, "v.testnet", async () => "again")).resolves.toBe("again");
});

const VAULT = "vault.late.testnet";
const ev = (event: string, data: string) => `EVENT_JSON:{"standard":"foundling","version":"1.0.0","event":"${event}","data":[${data}]}`;
function synthTx(hash: string, block: number, logs: string[]): FastnearTx {
  const eo = { block_timestamp: block * 1_000_000_000, block_height: block, index: 0, id: `R-${hash}`, outcome: { logs, executor_id: VAULT, status: { SuccessValue: "" } } };
  return { transaction: { hash, signer_id: "keeper.testnet" }, receipts: [{ execution_outcome: eo }] } as FastnearTx;
}

test("a decision that lands 200 blocks later joins its cycle and queues a proof", async () => {
  const start = synthTx("TSTART", 1000, [ev("cycle_started", `{"nonce":1}`)]);
  const late = synthTx("TLATE", 1200, [ev("decision", `{"nonce":1,"decision":"{}"}`)]);
  const rpc = fakeRpc();
  await indexOnce({ db, fastnear: fakeFastnear([{ transaction_hash: "TSTART", tx_block_height: 1000 }], [start]), rpc, vaultId: VAULT, log });
  expect(await count("proofs")).toBe(0);

  const both = fakeFastnear([{ transaction_hash: "TSTART", tx_block_height: 1000 }, { transaction_hash: "TLATE", tx_block_height: 1200 }], [start, late]);
  const r = await indexOnce({ db, fastnear: both, rpc, vaultId: VAULT, log });
  expect(r.stored).toBe(1);
  const cycles = await sql<{ nonce: string; trigger_tx: string; decision_tx: string; closing: string | null; last_block: string }>(url, "select * from cycles");
  expect(cycles).toEqual([expect.objectContaining({ nonce: "1", trigger_tx: "TSTART", decision_tx: "TLATE", closing: null, last_block: "1200" })]);
  const proofs = await sql<{ nonce: string; verifier_state: string; obs_state: string; replay: string }>(url, "select * from proofs");
  expect(proofs).toEqual([expect.objectContaining({ nonce: "1", verifier_state: "queued", obs_state: "queued", replay: "sealed" })]);
  expect(await count("nav_points")).toBe(0);
});

test("each closed cycle gets exactly one nav point read at its last block", async () => {
  const m12 = fixture("m12");
  const rpc = fakeRpc();
  const deps = { db, fastnear: m12.fastnear, rpc, vaultId: m12.vault, log };
  await indexOnce(deps);
  await indexOnce(deps);
  const closed = await sql<{ nonce: string; last_block: string; finished_at: Date }>(url, "select nonce, last_block, finished_at from cycles where closing is not null order by nonce");
  expect(closed.length).toBeGreaterThan(0);
  const nav = await sql<{ nonce: string; block_height: string; at: Date; book_usdc: string; book_wnear: string; total_shares: string; oracle_near: string; oracle_usdc: string }>(url, "select * from nav_points order by nonce");
  expect(nav.map((n) => [n.nonce, n.block_height])).toEqual(closed.map((c) => [c.nonce, c.last_block]));
  expect(nav[0]).toMatchObject({ book_usdc: "900", book_wnear: "5", total_shares: "1000", oracle_near: "300000000", oracle_usdc: "100000000", at: closed[0]!.finished_at });
  expect(rpc.calls.filter((c) => c.startsWith("book@"))).toHaveLength(closed.length);
});

test("missing oracle prices are stored as null", async () => {
  const m12 = fixture("m12");
  await indexOnce({ db, fastnear: m12.fastnear, rpc: fakeRpc("null"), vaultId: m12.vault, log });
  const nav = await sql<{ oracle_near: string | null; oracle_usdc: string | null }>(url, "select oracle_near, oracle_usdc from nav_points");
  expect(nav.length).toBeGreaterThan(0);
  expect(nav.every((n) => n.oracle_near === null && n.oracle_usdc === null)).toBe(true);
});

test("rederiveAll rebuilds every cycle and queued proof from the events alone", async () => {
  const m12 = fixture("m12");
  await indexOnce({ db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: m12.vault, log });
  const before = await sql(url, "select * from cycles order by nonce");
  await sql(url, "delete from cycles; delete from proofs;");
  await expect(rederiveAll(db, m12.vault)).resolves.toBe(7);
  expect(await sql(url, "select * from cycles order by nonce")).toEqual(before);
  expect(await count("proofs")).toBe(7);
});

test("a cycle that closes without a decision gets a final skip proof at once", async () => {
  const t = synthTx("TABORT", 1000, [ev("cycle_started", `{"nonce":4}`), ev("cycle_aborted", `{"nonce":4}`)]);
  await indexOnce({ db, fastnear: fakeFastnear([{ transaction_hash: "TABORT", tx_block_height: 1000 }], [t]), rpc: fakeRpc(), vaultId: VAULT, log });
  const p = (await sql<{ verifier: unknown; verifier_state: string; obs_recheck: unknown; obs_state: string; replay: string }>(url, "select * from proofs where nonce = 4"))[0];
  expect(p).toMatchObject({ verifier: { pass: 0, skip: 1, fail: 0 }, verifier_state: "done", obs_recheck: { pass: 0, skip: 1, fail: 0 }, obs_state: "done", replay: "skip" });
});

test("an open cycle without a decision has no proof row yet", async () => {
  const t = synthTx("TOPEN", 1000, [ev("cycle_started", `{"nonce":5}`)]);
  await indexOnce({ db, fastnear: fakeFastnear([{ transaction_hash: "TOPEN", tx_block_height: 1000 }], [t]), rpc: fakeRpc(), vaultId: VAULT, log });
  expect(await count("proofs")).toBe(0);
});

test("a nav read that keeps failing for one cycle does not hold back the others", async () => {
  const m12 = fixture("m12");
  const base = fakeRpc();
  const closed = await (async () => {
    await indexOnce({ db, fastnear: m12.fastnear, rpc: { ...base, viewAt: async () => { throw new Error("archival down"); } }, vaultId: m12.vault, log }).catch(() => {});
    return sql<{ nonce: string; last_block: string }>(url, "select nonce, last_block from cycles where closing is not null order by nonce");
  })();
  const bad = BigInt(closed[0]!.last_block);
  const rpc = { ...base, async viewAt<T>(block: bigint, c: string, m: string): Promise<T> { if (block === bad) throw new Error("block gone everywhere"); return base.viewAt<T>(block, c, m); } };
  await indexOnce({ db, fastnear: m12.fastnear, rpc, vaultId: m12.vault, log });
  expect(await count("nav_points")).toBe(closed.length - 1);
  const state = (await sql<{ last_error: string; indexed_at: Date | null }>(url, "select last_error, indexed_at from sync_state"))[0]!;
  expect(state.last_error).toMatch(new RegExp(`nav for cycle ${closed[0]!.nonce}.*block gone everywhere`));
  expect(state.indexed_at).toBeInstanceOf(Date);
});

test("a transaction FastNEAR does not return fails the round instead of being skipped", async () => {
  const start = synthTx("TSTART", 1000, [ev("cycle_started", `{"nonce":1}`)]);
  const listed = [{ transaction_hash: "TSTART", tx_block_height: 1000 }, { transaction_hash: "TMISSING", tx_block_height: 1500 }];
  const fastnear = { ...fakeFastnear(listed, [start]), async transactions(hashes: string[]) { return hashes.filter((h) => h === "TSTART").map(() => start); } };
  await expect(indexOnce({ db, fastnear, rpc: fakeRpc(), vaultId: VAULT, log })).rejects.toThrow(/TMISSING/);
  expect((await sql<{ position: string }>(url, "select position from sync_state"))[0]!.position).toBe("0");
});

test("a successful round records indexed_at and the tip it scanned to; a failed round does not", async () => {
  const m12 = fixture("m12");
  await indexOnce({ db, fastnear: m12.fastnear, rpc: fakeRpc("ok", 300_000_000n), vaultId: m12.vault, log });
  const ok = (await sql<{ indexed_at: Date; scanned_tip: string }>(url, "select indexed_at, scanned_tip from sync_state"))[0]!;
  expect(ok.scanned_tip).toBe("300000000");
  const broken = { ...m12.fastnear, async *accountTxs() { throw new Error("fastnear down"); } };
  await expect(indexOnce({ db, fastnear: broken, rpc: fakeRpc("ok", 300_000_500n), vaultId: m12.vault, log })).rejects.toThrow();
  const after = (await sql<{ indexed_at: Date; scanned_tip: string; tip: string; heartbeat_at: Date }>(url, "select * from sync_state"))[0]!;
  expect(after.indexed_at).toEqual(ok.indexed_at);
  expect(after.scanned_tip).toBe("300000000");
  expect(after.tip).toBe("300000500");
  expect(after.heartbeat_at.getTime()).toBeGreaterThan(ok.indexed_at.getTime());
});
