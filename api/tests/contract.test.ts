import { db as connect } from "@foundling/db";
import { z } from "zod";
import { cycleSchema, envelopeSchema, navSchema, proofSchema, statusSchema } from "@/lib/history/schemas";
import { createApp } from "../src/app";
import { M12, lockTestDb, readerUrl, seedM12, url } from "./seed";

const { db, pool } = connect(readerUrl, 2);
let lock: Awaited<ReturnType<typeof lockTestDb>>;
beforeAll(async () => {
  lock = await lockTestDb(url);
  await seedM12();
});
afterAll(async () => {
  await pool.end();
  await lock.release();
});

const app = () => createApp({ db, vaultId: M12, webOrigin: "https://foundling.test", trustProxyFrom: [] });
const env = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };

async function body(path: string) {
  const res = await app().request(path, {}, env);
  expect(res.status).toBe(200);
  const json = envelopeSchema.parse(await res.json());
  expect(json).toMatchObject({ success: true, error: null });
  return json;
}

test("/v1/cycles matches the website's cycle schema", async () => {
  const rows = z.array(cycleSchema).parse((await body("/v1/cycles")).data);
  expect(rows.map((r) => r.nonce)).toEqual([7n, 6n, 5n, 4n, 3n, 2n, 1n]);
  const first = rows.find((r) => r.nonce === 1n)!;
  expect(first.events.map((e) => e.name)).toContain("executed");
  expect(first.amountIn).toBe(50000n);
  expect(new Set(first.txHashes).size).toBe(first.txHashes.length);
  expect(first.verifier).toEqual({ pass: 9, skip: 2, fail: 0, state: "done" });
  expect(rows.find((r) => r.nonce === 2n)!.verifier).toEqual({ pass: 0, skip: 0, fail: 0, state: "queued" });
});

test("/v1/cycles/:nonce, /v1/nav, /v1/status and /v1/proofs/:nonce match their schemas", async () => {
  expect(cycleSchema.parse((await body("/v1/cycles/3")).data).nonce).toBe(3n);
  const nav = z.array(navSchema).parse((await body("/v1/nav")).data);
  expect(nav.map((n) => n.nonce)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  expect(nav[0]!.oracle).toEqual({ near: 300000000n, usdc: 100000000n });
  const status = statusSchema.parse((await body("/v1/status")).data);
  // The last successful round scanned to the tip it read, so nothing is behind.
  expect(status.tipLag).toBe(0n);
  expect(proofSchema.parse((await body("/v1/proofs/1")).data)).toEqual({ verifier: { pass: 9, skip: 2, fail: 0, state: "done" }, obsRecheck: { pass: 0, skip: 0, fail: 0, state: "queued" }, replay: "pass", verifierCommit: null });
});

test("/v1/events pages with a cursor and filters by name", async () => {
  const page = await body("/v1/events?limit=5");
  const rows = z.array(z.object({ name: z.string(), tx_hash: z.string(), block_height: z.string() }).loose()).parse(page.data);
  expect(rows).toHaveLength(5);
  const next = await body(`/v1/events?limit=5&cursor=${page.meta!.cursor}`);
  const all = [...rows, ...(next.data as typeof rows)];
  const heights = all.map((r) => BigInt(r.block_height));
  expect(heights).toEqual([...heights].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
  const swaps = z.array(z.object({ name: z.string() }).loose()).parse((await body("/v1/events?name=executed")).data);
  expect(swaps.map((s) => s.name)).toEqual(["executed", "executed", "executed", "executed"]);
});
