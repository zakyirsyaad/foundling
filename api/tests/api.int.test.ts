import { db as connect } from "@foundling/db";
import pg from "pg";
import { createApp } from "../src/app";
import { M12, lockTestDb, readerUrl, seedM12, url } from "./seed";

const { db, pool } = connect(readerUrl, 4, { statementTimeoutMs: 300 });
let lock: Awaited<ReturnType<typeof lockTestDb>>;
beforeAll(async () => {
  lock = await lockTestDb(url);
  await seedM12();
});
afterAll(async () => {
  await pool.end();
  await lock.release();
});

const ORIGIN = "https://foundling.test";
const app = () => createApp({ db, vaultId: M12, webOrigin: ORIGIN, trustProxyFrom: [] });
const env = { incoming: { socket: { remoteAddress: "10.0.0.2" } } };
const get = (a: ReturnType<typeof app>, path: string, init: RequestInit = {}) => a.request(path, init, env);

test("filter=hold gives only hold cycles, filter=executed only executed ones", async () => {
  const a = app();
  const hold = await (await get(a, "/v1/cycles?filter=hold")).json();
  expect(hold.data).toEqual([]);
  const executed = await (await get(a, "/v1/cycles?filter=executed")).json();
  expect(executed.data.map((c: { nonce: string }) => c.nonce)).toEqual(["5", "4", "3", "1"]);
  const other = await (await get(a, "/v1/cycles?filter=other")).json();
  expect(other.data.map((c: { nonce: string }) => c.nonce)).toEqual(["7", "6", "2"]);
});

test("cycles page by nonce with a cursor", async () => {
  const a = app();
  const p1 = await (await get(a, "/v1/cycles?limit=3")).json();
  expect(p1.data.map((c: { nonce: string }) => c.nonce)).toEqual(["7", "6", "5"]);
  const p2 = await (await get(a, `/v1/cycles?limit=3&cursor=${p1.meta.cursor}`)).json();
  expect(p2.data.map((c: { nonce: string }) => c.nonce)).toEqual(["4", "3", "2"]);
  const p3 = await (await get(a, `/v1/cycles?limit=3&cursor=${p2.meta.cursor}`)).json();
  expect(p3.data.map((c: { nonce: string }) => c.nonce)).toEqual(["1"]);
  expect(p3.meta.cursor).toBeNull();
});

test.each([
  ["/v1/cycles?limit=1000"],
  ["/v1/cycles?limit=0"],
  ["/v1/cycles?cursor=garbage"],
  ["/v1/cycles?filter=nope"],
  ["/v1/cycles/-1"],
  ["/v1/cycles/abc"],
  ["/v1/events?cursor=bm9wZQ"],
  ["/v1/nav?from=yesterday"],
  ["/v1/proofs/1.5"],
])("%s is refused with 400 and the envelope", async (path) => {
  const res = await get(app(), path);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ success: false, data: null, error: expect.any(String) });
});

test("an unknown nonce is 404 with the envelope", async () => {
  for (const path of ["/v1/cycles/999999", "/v1/proofs/999999"]) {
    const res = await get(app(), path);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, data: null, error: expect.any(String) });
  }
});

test("an unknown path is 404 with the envelope", async () => {
  const res = await get(app(), "/v2/anything");
  expect(res.status).toBe(404);
  expect((await res.json()).success).toBe(false);
});

test("POST is 405", async () => {
  const res = await get(app(), "/v1/cycles", { method: "POST", body: "{}" });
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("GET");
  expect((await res.json()).success).toBe(false);
});

test("answers carry nosniff, JSON and CORS for the website only", async () => {
  const res = await get(app(), "/v1/status", { headers: { origin: ORIGIN } });
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const other = await get(app(), "/v1/status", { headers: { origin: "https://evil.example" } });
  expect(other.headers.get("access-control-allow-origin")).toBeNull();
  const pre = await get(app(), "/v1/status", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
  expect(pre.headers.get("access-control-allow-methods")).toBe("GET");
});

test("the 61st request in a minute from one address is 429", async () => {
  const a = app();
  for (let i = 0; i < 60; i++) expect((await get(a, "/v1/status")).status).toBe(200);
  const res = await get(a, "/v1/status");
  expect(res.status).toBe(429);
  expect((await res.json()).success).toBe(false);
  const otherIp = await a.request("/v1/status", {}, { incoming: { socket: { remoteAddress: "10.0.0.3" } } });
  expect(otherIp.status).toBe(200);
});

test("a query past statement_timeout is 503, not a hang", async () => {
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    await locker.query("begin; lock table cycles in access exclusive mode;");
    const started = Date.now();
    const res = await get(app(), "/v1/cycles");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, error: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    await locker.query("rollback");
    await locker.end();
  }
});

test("status is 404 until the worker has written a heartbeat", async () => {
  const res = await createApp({ db, vaultId: "never.indexed.testnet", webOrigin: ORIGIN, trustProxyFrom: [] }).request("/v1/status", {}, env);
  expect(res.status).toBe(404);
});

test("the reader role cannot write", async () => {
  await expect(pool.query("insert into sync_state (vault_id, position) values ('x', 1)")).rejects.toThrow(/permission denied/);
});

test("nav honours the from and to range", async () => {
  const all = (await (await get(app(), "/v1/nav")).json()).data as { nonce: string; at: string }[];
  const from = all[2]!.at;
  const to = all[4]!.at;
  const some = (await (await get(app(), `/v1/nav?from=${from}&to=${to}`)).json()).data as { nonce: string }[];
  expect(some.map((n) => n.nonce)).toEqual([all[2]!.nonce, all[3]!.nonce, all[4]!.nonce]);
});

test("a proof row in a state the website does not know shows no tally", async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query("update proofs set verifier_state = 'mystery' where nonce = 2");
    const body = await (await get(app(), "/v1/proofs/2")).json();
    expect(body.data.verifier).toBeNull();
    expect(body.data.obs_recheck).toEqual({ pass: 0, skip: 0, fail: 0, state: "queued" });
  } finally {
    await admin.query("update proofs set verifier_state = 'queued' where nonce = 2");
    await admin.end();
  }
});

test("an unreachable database is 503", async () => {
  const away = connect("postgres://localhost:1/nowhere", 1);
  try {
    const res = await createApp({ db: away.db, vaultId: M12, webOrigin: ORIGIN, trustProxyFrom: [] }).request("/v1/status", {}, env);
    expect(res.status).toBe(503);
  } finally {
    await away.pool.end();
  }
});

test("an unexpected failure is 500 with the envelope and no detail", async () => {
  const logged: string[] = [];
  const broken = { select: () => { throw new Error("secret detail"); } } as unknown as typeof db;
  const res = await createApp({ db: broken, vaultId: M12, webOrigin: ORIGIN, trustProxyFrom: [], log: (m) => logged.push(m) }).request("/v1/status", {}, env);
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ success: false, data: null, error: "internal error", meta: null });
  expect(logged).toEqual(["api error"]);
});
