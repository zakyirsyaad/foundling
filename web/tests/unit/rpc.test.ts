import { ContractViewError, RpcBudgetExceeded, RpcUnavailable, createRpcClient } from "@/lib/chain/rpc";

const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const viewOk = (value: unknown, height = 100) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { result: enc(value), block_height: height, logs: [] } }), { status: 200 });

function fakeFetch(handlers: Array<(url: string, body: any) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body));
    const h = handlers[(calls.length - 1) % handlers.length]!;
    return h(url, body);
  };
  return { f: f as typeof fetch, calls };
}

test("falls back on 429 and returns the second answer", async () => {
  const { f, calls } = fakeFetch([() => new Response("", { status: 429 }), () => viewOk(7)]);
  const rpc = createRpcClient(["https://a", "https://b"], { fetch: f });
  const r = await rpc.view("v.near", "last_nonce", {}, (x) => x as number);
  expect(r).toEqual({ value: 7, blockHeight: 100n });
  expect(calls).toEqual(["https://a", "https://b"]);
});
test("throws RpcUnavailable when every URL fails", async () => {
  const { f } = fakeFetch([() => new Response("", { status: 503 })]);
  const rpc = createRpcClient(["https://a", "https://b"], { fetch: f });
  await expect(rpc.view("v.near", "stage", {}, (x) => x)).rejects.toBeInstanceOf(RpcUnavailable);
});
test("a contract error is not retried on another URL", async () => {
  const { f, calls } = fakeFetch([
    () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { error: "wasm execution failed with error: FunctionCallError(ExecutionError(\"Smart contract panicked: NOT_STUCK\"))", block_height: 5 } }), { status: 200 }),
  ]);
  const rpc = createRpcClient(["https://a", "https://b"], { fetch: f });
  const err = await rpc.view("v.near", "x", {}, (x) => x).catch((e) => e);
  expect(err).toBeInstanceOf(ContractViewError);
  expect(err.contractMessage).toMatch(/NOT_STUCK/);
  expect(calls).toHaveLength(1);
});
test("an RPC-level error such as an unknown account is a contract view error too", async () => {
  const { f, calls } = fakeFetch([() => new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "x" } }), { status: 200 })]);
  const rpc = createRpcClient(["https://a", "https://b"], { fetch: f });
  await expect(rpc.viewAccount("nobody.near")).rejects.toBeInstanceOf(ContractViewError);
  expect(calls).toHaveLength(1);
});
test("the call budget is enforced per client", async () => {
  const { f } = fakeFetch([() => viewOk(1)]);
  const rpc = createRpcClient(["https://a"], { fetch: f, budget: 40 });
  for (let i = 0; i < 40; i++) await rpc.view("v.near", "m", {}, (x) => x);
  await expect(rpc.view("v.near", "m", {}, (x) => x)).rejects.toBeInstanceOf(RpcBudgetExceeded);
});
test("a timeout moves to the next URL", async () => {
  vi.useFakeTimers();
  try {
    const { f, calls } = fakeFetch([
      (_u, _b) => new Promise<Response>(() => {}),
      () => viewOk(3),
    ]);
    const rpc = createRpcClient(["https://slow", "https://fast"], { fetch: f, timeoutMs: 4000 });
    const p = rpc.view("v.near", "m", {}, (x) => x);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(p).resolves.toEqual({ value: 3, blockHeight: 100n });
    expect(calls).toEqual(["https://slow", "https://fast"]);
  } finally {
    vi.useRealTimers();
  }
});
test("sends a final-finality call_function with base64 JSON args", async () => {
  let sent: any;
  const { f } = fakeFetch([(_u, b) => ((sent = b), viewOk("ok"))]);
  await createRpcClient(["https://a"], { fetch: f }).view("v.near", "bucket_claim", { nonce: 3, account: "a.near" }, (x) => x);
  expect(sent.params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "v.near", method_name: "bucket_claim" });
  expect(JSON.parse(atob(sent.params.args_base64))).toEqual({ nonce: 3, account: "a.near" });
});
test("reads the final block, an account, access keys and the gas price", async () => {
  const answers: Record<string, unknown> = {
    block: { header: { height: 120, timestamp: "1800000000123456789" } },
    view_account: { amount: "5000000000000000000000000", storage_usage: 1234, code_hash: "Hash1", block_height: 121 },
    view_access_key_list: { keys: [{}, {}], block_height: 122 },
    gas_price: { gas_price: "100000000" },
  };
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    const key = b.method === "query" ? b.params.request_type : b.method;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: answers[key] }), { status: 200 });
  }) as typeof fetch;
  const rpc = createRpcClient(["https://a"], { fetch: f });
  expect(await rpc.finalBlock()).toEqual({ height: 120n, timestampSeconds: 1800000000n });
  expect(await rpc.viewAccount("v.near")).toEqual({ value: { amount: 5n * 10n ** 24n, storageUsage: 1234n, codeHash: "Hash1" }, blockHeight: 121n });
  expect(await rpc.accessKeyCount("v.near")).toEqual({ value: 2, blockHeight: 122n });
  expect(await rpc.gasPrice()).toBe(100000000n);
});
test("a provider-side RPC error moves to the next URL; an unknown account does not", async () => {
  const internal = new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" }, message: "x" } }), { status: 200 });
  const { f, calls } = fakeFetch([() => internal.clone(), () => viewOk(9)]);
  const r = await createRpcClient(["https://a", "https://b"], { fetch: f }).view("v.near", "m", {}, (x) => x);
  expect(r.value).toBe(9);
  expect(calls).toHaveLength(2);
});
