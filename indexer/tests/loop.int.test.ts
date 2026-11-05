import { db as connect, migrate } from "@foundling/db";
import { lockTestDb, resetDb, sql } from "../../packages/db/tests/helpers";
import { indexOnce, withVaultLock } from "../src/loop";
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
