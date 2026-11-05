import { createFastnear } from "../src/fastnear";
import { createArchivalRpc, ONE_HOUR_BLOCKS } from "../src/rpc";

type Call = { url: string; body: any; headers: Record<string, string> };

function fakeFetch(answer: (call: Call, n: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(call);
    const { status = 200, json } = answer(call, calls.length - 1);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const VAULT = "vault.fdl-m12-0d1276.testnet";
const BASE = "https://tx.test.fastnear.com";

describe("FastNEAR", () => {
  test("follows resume_token until a page comes back without one", async () => {
    const { f, calls } = fakeFetch((_, n) => ({
      json: { account_txs: [{ transaction_hash: `H${n}`, tx_block_height: 100 + n }], ...(n < 3 ? { resume_token: `t${n}` } : {}) },
    }));
    const got = [];
    for await (const t of createFastnear(BASE, f).accountTxs(VAULT, 42n)) got.push(t.transaction_hash);
    expect(got).toEqual(["H0", "H1", "H2", "H3"]);
    expect(calls.map((c) => c.url)).toEqual(Array(4).fill(`${BASE}/v0/account`));
    expect(calls[0]!.body).toEqual({ account_id: VAULT, is_receiver: true, desc: false, from_tx_block_height: 42 });
    expect(calls[2]!.body).toMatchObject({ desc: false, is_receiver: true, resume_token: "t1" });
  });

  test("asks for transactions in batches of 20", async () => {
    const { f, calls } = fakeFetch((c) => ({ json: { transactions: c.body.tx_hashes.map((h: string) => ({ hash: h })) } }));
    const hashes = Array.from({ length: 45 }, (_, i) => `H${i}`);
    const txs = await createFastnear(BASE, f).transactions(hashes);
    expect(calls.map((c) => c.body.tx_hashes.length)).toEqual([20, 20, 5]);
    expect(calls[0]!.url).toBe(`${BASE}/v0/transactions`);
    expect(txs).toHaveLength(45);
  });

  test("sends the API key only when one is set", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { transactions: [] } }));
    await createFastnear(BASE, f, "k-123").transactions(["H"]);
    await createFastnear(BASE, f).transactions(["H"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer k-123");
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  test("retries HTTP 429 after 1, 2 and 4 seconds, then throws", async () => {
    vi.useFakeTimers();
    try {
      const { f, calls } = fakeFetch(() => ({ status: 429, json: {} }));
      const p = createFastnear(BASE, f).transactions(["H"]);
      const settled = expect(p).rejects.toThrow(/429/);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toHaveLength(4);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  test("a 429 followed by an answer succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { f } = fakeFetch((_, n) => (n === 0 ? { status: 429, json: {} } : { json: { transactions: [{ hash: "H" }] } }));
      const p = createFastnear(BASE, f).transactions(["H"]);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("other HTTP errors throw at once", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 500, json: {} }));
    await expect(createFastnear(BASE, f).transactions(["H"])).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  test("a page without account_txs is rejected", async () => {
    const { f } = fakeFetch(() => ({ json: { nope: 1 } }));
    const it = createFastnear(BASE, f).accountTxs(VAULT, 0n);
    await expect(it.next()).rejects.toThrow();
  });
});

describe("archival RPC", () => {
  const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

  test("viewAt sends block_id and decodes the JSON result", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { jsonrpc: "2.0", id: 1, result: { result: bytes({ nav: "5" }) } } }));
    const got = await createArchivalRpc(["https://a"], f).viewAt<{ nav: string }>(1234n, VAULT, "get_nav", { x: 1 });
    expect(got).toEqual({ nav: "5" });
    expect(calls[0]!.body.params).toEqual({
      request_type: "call_function",
      block_id: 1234,
      account_id: VAULT,
      method_name: "get_nav",
      args_base64: Buffer.from(JSON.stringify({ x: 1 })).toString("base64"),
    });
  });

  test("moves to the next URL when a node no longer has the block", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url === "https://rpc"
        ? { json: { error: { cause: { name: "GARBAGE_COLLECTED_BLOCK" }, message: "gc" } } }
        : { json: { result: { result: bytes(7) } } },
    );
    await expect(createArchivalRpc(["https://rpc", "https://archival"], f).viewAt(1n, VAULT, "m", {})).resolves.toBe(7);
    expect(calls.map((c) => c.url)).toEqual(["https://rpc", "https://archival"]);
  });

  test("moves to the next URL on HTTP and network errors", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ result: { result: bytes(1) } }));
    }) as unknown as typeof fetch;
    await expect(createArchivalRpc(["https://a", "https://b", "https://c"], f).viewAt(1n, VAULT, "m", {})).resolves.toBe(1);
  });

  test("a contract error is thrown without trying other URLs", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { error: { cause: { name: "CONTRACT_EXECUTION_ERROR" }, message: "MethodNotFound" } } }));
    await expect(createArchivalRpc(["https://a", "https://b"], f).viewAt(1n, VAULT, "m", {})).rejects.toThrow(/MethodNotFound/);
    expect(calls).toHaveLength(1);
  });

  test("throws when every URL fails", async () => {
    const { f } = fakeFetch(() => ({ status: 502, json: {} }));
    await expect(createArchivalRpc(["https://a", "https://b"], f).tip()).rejects.toThrow(/every RPC endpoint failed/);
  });

  test("tip reads the final block height", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { result: { header: { height: 275762300 } } } }));
    await expect(createArchivalRpc(["https://a"], f).tip()).resolves.toBe(275762300n);
    expect(calls[0]!.body).toMatchObject({ method: "block", params: { finality: "final" } });
  });

  test("one hour is 6000 blocks", () => {
    expect(ONE_HOUR_BLOCKS).toBe(6000n);
  });
});
