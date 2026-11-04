import { createHistoryClient } from "@/lib/history/client";

const ok = (data: unknown, meta: unknown = { cursor: null }) => new Response(JSON.stringify({ success: true, data, error: null, meta }), { status: 200 });
const cycle = (nonce: number) => ({
  nonce: String(nonce), started_at: "2026-11-10T00:00:00Z", finished_at: null, events: [{ name: "cycle_started" }],
  amount_in: null, amount_out: null, tx_hashes: ["abc"], verifier: null, obs_recheck: null,
});
const client = (f: (url: string) => Response | Promise<Response>, timeoutMs?: number) =>
  createHistoryClient("https://api.example.org", { fetch: (async (u: RequestInfo | URL) => f(String(u))) as typeof fetch, timeoutMs });

test("no API origin is pending, not an error", async () => {
  expect(await createHistoryClient(null).cycles()).toEqual({ status: "pending", reason: "unconfigured" });
});
test("HTTP failures and a false success are pending", async () => {
  expect(await client(() => new Response("", { status: 503 })).cycles()).toEqual({ status: "pending", reason: "http" });
  expect(await client(() => new Response(JSON.stringify({ success: false, data: null, error: "x", meta: null }))).cycles()).toEqual({ status: "pending", reason: "http" });
});
test("a malformed body is pending/invalid", async () => {
  expect(await client(() => ok([{ nonce: 3 }])).cycles()).toEqual({ status: "pending", reason: "invalid" });
  expect(await client(() => new Response("not json")).cycles()).toEqual({ status: "pending", reason: "invalid" });
});
test("more than 100 rows is pending/invalid", async () => {
  expect(await client(() => ok(Array.from({ length: 101 }, (_, i) => cycle(i)))).cycles()).toEqual({ status: "pending", reason: "invalid" });
});
test("rows parse with exact amounts and the cursor", async () => {
  const row = { ...cycle(7), amount_in: "340282366920938463463374607431768211455", verifier: { pass: 5, skip: 1, fail: 0, state: "done" } };
  const r = await client(() => ok([row], { cursor: "c2" })).cycles();
  expect(r).toEqual({
    status: "ok", cursor: "c2",
    data: [{ nonce: 7n, startedAt: "2026-11-10T00:00:00Z", finishedAt: null, events: [{ name: "cycle_started" }], amountIn: 2n ** 128n - 1n, amountOut: null, txHashes: ["abc"], verifier: { pass: 5, skip: 1, fail: 0, state: "done" }, obsRecheck: null }],
  });
});
test("the query string carries the filter and the cursor", async () => {
  let seen = "";
  await client((u) => ((seen = u), ok([]))).cycles({ filter: "hold", cursor: "c1" });
  expect(seen).toBe("https://api.example.org/v1/cycles?filter=hold&cursor=c1");
});
test("nav points and the worker status parse", async () => {
  const nav = await client(() => ok([{ nonce: "1", at: "2026-11-01T00:00:00Z", book: { usdc: "1000000", wnear: "0" }, total_shares: "1000000000000", oracle: null }])).nav({});
  expect(nav).toEqual({ status: "ok", cursor: null, data: [{ nonce: 1n, at: "2026-11-01T00:00:00Z", book: { usdc: 1_000_000n, wnear: 0n }, totalShares: 10n ** 12n, oracle: null }] });
  const st = await client(() => ok({ position: "276208440", heartbeat_at: "2026-11-10T00:00:00Z", tip_lag: "3" })).status();
  expect(st).toEqual({ status: "ok", cursor: null, data: { position: 276208440n, heartbeatAt: "2026-11-10T00:00:00Z", tipLag: 3n } });
});
test("a proof result parses", async () => {
  const r = await client(() => ok({ verifier: { pass: 3, skip: 1, fail: 0, state: "done" }, obs_recheck: null, replay: "sealed" })).proof(7n);
  expect(r).toEqual({ status: "ok", cursor: null, data: { verifier: { pass: 3, skip: 1, fail: 0, state: "done" }, obsRecheck: null, replay: "sealed" } });
});
test("a slow API is pending/timeout", async () => {
  vi.useFakeTimers();
  try {
    const p = client(() => new Promise<Response>(() => {}), 1500).cycles();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toEqual({ status: "pending", reason: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});
