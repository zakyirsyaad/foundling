import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db as connect, migrate } from "@foundling/db";
import { lockTestDb, resetDb, sql } from "../../packages/db/tests/helpers";
import { indexOnce } from "../src/loop";
import { processOne, type ToolPaths } from "../src/proofs/queue";
import { GIVE_UP_AFTER_MS } from "../src/proofs/run";
import { fakeRpc, fixture, log } from "./support";

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

const bin = (n: string) => join(__dirname, "bin", n);
const tools: ToolPaths = { python: "/bin/sh", fetchProof: bin("fetch_proof.sh"), recheckObs: bin("recheck_obs.sh"), verify: bin("foundling-verify.sh"), rpcUrls: ["https://archival.test"], timeoutMs: 2000 };
const m12 = fixture("m12");
let logFile = "";

function rpcWithReveal(revealed: boolean) {
  const base = fakeRpc();
  return {
    ...base,
    async viewAt<T>(block: bigint, contract: string, method: string): Promise<T> {
      if (method === "revealed") return (revealed ? "{\"risk\":3}" : null) as T;
      if (method === "revealed_salt") throw new Error("old vaults have no revealed_salt view");
      return base.viewAt<T>(block, contract, method);
    },
  };
}

async function seed(): Promise<void> {
  await resetDb(url);
  await migrate(url);
  await indexOnce({ db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: m12.vault, log });
  // Keep only nonce 1 queued so each test drives one proof.
  await sql(url, "delete from proofs where nonce <> 1");
  await sql(url, "delete from events where name = 'revealed'");
}

beforeEach(async () => {
  await seed();
  logFile = join(mkdtempSync(join(tmpdir(), "fdl-proof-")), "calls.log");
  process.env.FAKE_LOG = logFile;
  for (const k of ["FAKE_FETCH", "FAKE_VERIFY", "FAKE_RECHECK", "FAKE_OPENING"]) delete process.env[k];
});

const calls = () => { try { return readFileSync(logFile, "utf8").trim().split("\n"); } catch { return []; } };
type Bundle = { approved_measurements: unknown; opening?: unknown; cycles: { collateral: { pck_certificate_chain: string } }[] };
type Row = { bundle: Bundle | null; approved_measurements: unknown; verifier: unknown; verifier_state: string; obs_recheck: unknown; obs_state: string; replay: string; attempts: number; next_attempt_at: Date; revealed_applied: number; verifier_commit: string | null; last_error: string | null };
/** The bundle is stored as the raw text fetch_proof wrote. */
const row = async () => {
  const r = (await sql<Omit<Row, "bundle"> & { bundle: string | null }>(url, "select * from proofs where nonce = 1"))[0]!;
  return { ...r, bundle: r.bundle === null ? null : (JSON.parse(r.bundle) as Bundle) };
};
const fastnear = { transactions: async (hashes: string[]) => hashes.map((h) => ({ transaction: { hash: h, signer_id: "alice.testnet" }, receipts: [] })) };
const deps = (over: Partial<Parameters<typeof processOne>[0]> = {}) => ({
  db, fastnear, vaultId: m12.vault, chain: "testnet" as const, obsSource: "live" as const, tools, rpc: rpcWithReveal(false), now: () => new Date(), verifierCommit: "abc1234", ...over,
});

test("a successful run stores the bundle, both tallies and done", async () => {
  expect(await processOne(deps())).toBe(true);
  const r = await row();
  expect(r.bundle!.approved_measurements).toEqual([{ mrtd: "aa" }]);
  expect(r.bundle!.cycles[0]!.collateral.pck_certificate_chain).toBe("-----END CERTIFICATE-----\n\u0000");
  expect(r.approved_measurements).toEqual([{ mrtd: "aa" }]);
  expect(r).toMatchObject({ verifier: { pass: 6, skip: 1, fail: 0 }, verifier_state: "done", obs_recheck: { pass: 3, skip: 0, fail: 0 }, obs_state: "done", replay: "sealed", verifier_commit: "abc1234" });
  const fetchCall = calls().find((c) => c.startsWith("fetch"))!;
  expect(fetchCall).toContain(`--chain testnet --vault ${m12.vault} --collateral-bin ${tools.verify} --out`);
  expect(fetchCall).toContain("--rpc https://archival.test");
  expect(await processOne(deps())).toBe(false);
});

test("recheck exit 1 records the failure and is final", async () => {
  process.env.FAKE_RECHECK = "fail";
  await processOne(deps());
  expect(await row()).toMatchObject({ obs_recheck: { pass: 2, skip: 0, fail: 1 }, obs_state: "done" });
});

test("a source that stays down backs off and is recorded as skip after 24 hours", async () => {
  process.env.FAKE_RECHECK = "down";
  let now = new Date("2026-11-10T00:00:00Z");
  const clock = () => now;
  await processOne(deps({ now: clock }));
  let r = await row();
  expect(r).toMatchObject({ verifier_state: "done", obs_state: "queued", attempts: 1 });
  expect(r.next_attempt_at.getTime() - now.getTime()).toBe(5 * 60_000);
  expect(await processOne(deps({ now: clock }))).toBe(false); // not due yet

  now = new Date(now.getTime() + 5 * 60_000);
  await processOne(deps({ now: clock }));
  r = await row();
  expect(r.attempts).toBe(2);
  expect(r.next_attempt_at.getTime() - now.getTime()).toBe(15 * 60_000);

  now = new Date(Date.parse("2026-11-10T00:00:00Z") + GIVE_UP_AFTER_MS);
  await processOne(deps({ now: clock }));
  expect(await row()).toMatchObject({ obs_recheck: { pass: 0, skip: 1, fail: 0 }, obs_state: "done" });
  expect(calls().filter((c) => c.startsWith("fetch"))).toHaveLength(1);
});

test("a fetch that cannot read its sources backs off, then fails to build after 24 hours", async () => {
  process.env.FAKE_FETCH = "down";
  let now = new Date("2026-11-10T00:00:00Z");
  await processOne(deps({ now: () => now }));
  expect(await row()).toMatchObject({ bundle: null, verifier_state: "queued", attempts: 1, last_error: expect.stringMatching(/exit 2/) });
  now = new Date(now.getTime() + GIVE_UP_AFTER_MS);
  await processOne(deps({ now: () => now }));
  expect(await row()).toMatchObject({ bundle: null, verifier_state: "failed_to_build", obs_state: "done", obs_recheck: { pass: 0, skip: 1, fail: 0 } });
  expect(await processOne(deps({ now: () => now }))).toBe(false);
});

test("a bundle that is not JSON is retried, not a crash", async () => {
  process.env.FAKE_FETCH = "garbage";
  await expect(processOne(deps())).resolves.toBe(true);
  expect(await row()).toMatchObject({ bundle: null, attempts: 1, last_error: expect.stringMatching(/not readable JSON/) });
});

test("a verifier without SUMMARY is failed_to_build after 24 hours", async () => {
  process.env.FAKE_VERIFY = "nosummary";
  let now = new Date("2026-11-10T00:00:00Z");
  await processOne(deps({ now: () => now }));
  expect((await row()).verifier_state).toBe("queued");
  now = new Date(now.getTime() + GIVE_UP_AFTER_MS);
  await processOne(deps({ now: () => now }));
  expect(await row()).toMatchObject({ verifier_state: "failed_to_build", verifier: null });
});

test("a hanging tool is timed out while the index round keeps its heartbeat", async () => {
  process.env.FAKE_FETCH = "hang";
  const before = (await sql<{ heartbeat_at: Date }>(url, "select heartbeat_at from sync_state"))[0]!.heartbeat_at;
  const slow = processOne(deps({ tools: { ...tools, timeoutMs: 1500 } }));
  await new Promise((r) => setTimeout(r, 100));
  await indexOnce({ db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: m12.vault, log });
  const during = (await sql<{ heartbeat_at: Date }>(url, "select heartbeat_at from sync_state"))[0]!.heartbeat_at;
  expect(during.getTime()).toBeGreaterThan(before.getTime());
  await slow;
  expect(await row()).toMatchObject({ bundle: null, attempts: 1, last_error: expect.stringMatching(/timed out/) });
});

test("a reveal re-runs only the verifier and replaces sealed", async () => {
  await processOne(deps());
  const first = await row();
  expect(first.replay).toBe("sealed");
  await sql(url, `insert into events (vault_id, receipt_id, log_index, tx_hash, block_height, receipt_index, block_time, name, nonce, account, data)
                  values ($1, 'RREVEAL', 0, 'TREVEAL', 999999999, 0, now(), 'revealed', null, null, '{"salt":"abc"}')`, [m12.vault]);
  expect(await processOne(deps({ rpc: rpcWithReveal(true) }))).toBe(true);
  const r = await row();
  expect(r.bundle!.opening).toEqual({ params: "{\"risk\":3}", salt: "abc" });
  expect(r).toMatchObject({ verifier: { pass: 7, skip: 0, fail: 0 }, replay: "pass", revealed_applied: 1, obs_recheck: first.obs_recheck });
  expect(calls().filter((c) => c.startsWith("recheck"))).toHaveLength(1);
  expect(calls().filter((c) => c.startsWith("fetch"))).toHaveLength(1);
  expect(await processOne(deps({ rpc: rpcWithReveal(true) }))).toBe(false);
});

test("a bundle fetched after the reveal already carries the opening", async () => {
  process.env.FAKE_OPENING = "1";
  await sql(url, `insert into events (vault_id, receipt_id, log_index, tx_hash, block_height, receipt_index, block_time, name, nonce, account, data)
                  values ($1, 'RREVEAL', 0, 'TREVEAL', 999999999, 0, now(), 'revealed', null, null, '{"salt":"abc"}')`, [m12.vault]);
  await processOne(deps({ rpc: rpcWithReveal(true) }));
  expect(await row()).toMatchObject({ replay: "pass", revealed_applied: 1 });
  expect(calls().filter((c) => c.startsWith("verify"))).toHaveLength(1);
});

test("after a reveal, fetch_proof gets the reveal transaction and its signer", async () => {
  await sql(url, `insert into events (vault_id, receipt_id, log_index, tx_hash, block_height, receipt_index, block_time, name, nonce, account, data)
                  values ($1, 'RREVEAL', 0, 'TREVEAL', 999999999, 0, now(), 'revealed', null, null, '{"salt":"abc"}')`, [m12.vault]);
  await processOne(deps({ rpc: rpcWithReveal(true) }));
  expect(calls().find((c) => c.startsWith("fetch"))).toContain("--reveal-tx TREVEAL --reveal-signer alice.testnet");
});

test("rehearsal never calls recheck_obs and records skip", async () => {
  await processOne(deps({ obsSource: "rehearsal" }));
  expect(await row()).toMatchObject({ obs_recheck: { pass: 0, skip: 1, fail: 0 }, obs_state: "done" });
  expect(calls().filter((c) => c.startsWith("recheck"))).toEqual([]);
});

test("a cycle without a trigger transaction is final at once", async () => {
  await sql(url, "update cycles set trigger_tx = null where nonce = 1");
  await processOne(deps());
  expect(await row()).toMatchObject({ verifier_state: "failed_to_build", obs_state: "done", last_error: expect.stringMatching(/no trigger/) });
  expect(calls()).toEqual([]);
});

async function addReveal() {
  await sql(url, `insert into events (vault_id, receipt_id, log_index, tx_hash, block_height, receipt_index, block_time, name, nonce, account, data)
                  values ($1, 'RREVEAL', 0, 'TREVEAL', 999999999, 0, now(), 'revealed', null, null, '{"salt":"abc"}')`, [m12.vault]);
}

test("a verifier that fails after the reveal is retried with backoff, then gives the replay up as skip", async () => {
  let now = new Date("2026-11-10T00:00:00Z");
  await processOne(deps({ now: () => now }));
  await addReveal();
  now = new Date("2026-11-12T00:00:00Z");
  process.env.FAKE_VERIFY = "nosummary";
  await processOne(deps({ rpc: rpcWithReveal(true), now: () => now }));
  let r = await row();
  expect(r).toMatchObject({ revealed_applied: 0, replay: "sealed", attempts: 1 });
  expect(r.next_attempt_at.getTime() - now.getTime()).toBe(5 * 60_000);
  now = new Date(now.getTime() + GIVE_UP_AFTER_MS);
  await processOne(deps({ rpc: rpcWithReveal(true), now: () => now }));
  r = await row();
  expect(r).toMatchObject({ revealed_applied: 1, replay: "skip", verifier: { pass: 6, skip: 1, fail: 0 } });
  expect(await processOne(deps({ rpc: rpcWithReveal(true), now: () => now }))).toBe(false);
});

test("an empty revealed view backs off instead of spinning", async () => {
  let now = new Date("2026-11-10T00:00:00Z");
  await processOne(deps({ now: () => now }));
  await addReveal();
  now = new Date("2026-11-12T00:00:00Z");
  await processOne(deps({ rpc: rpcWithReveal(false), now: () => now }));
  const r = await row();
  expect(r.next_attempt_at.getTime()).toBeGreaterThan(now.getTime());
  expect(await processOne(deps({ rpc: rpcWithReveal(false), now: () => now }))).toBe(false);
});

test("a thrown error is a problem with backoff, not a stuck head of the queue", async () => {
  await addReveal();
  const down = { transactions: async () => { throw new Error("fastnear down"); } };
  const now = new Date("2026-11-10T00:00:00Z");
  await expect(processOne(deps({ fastnear: down, rpc: rpcWithReveal(true), now: () => now }))).resolves.toBe(true);
  const r = await row();
  expect(r).toMatchObject({ attempts: 1, last_error: expect.stringMatching(/fastnear down/) });
  expect(r.next_attempt_at.getTime() - now.getTime()).toBe(5 * 60_000);
});
