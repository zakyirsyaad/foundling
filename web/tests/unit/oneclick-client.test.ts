import { OneClickUnavailable, createOneClick } from "@/lib/crosschain/client";

function fake(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(String(u), init);
  }) as typeof fetch;
  return { f, calls };
}

test("quote posts the request and returns the signed answer", async () => {
  const { f, calls } = fake(() => new Response(JSON.stringify({ signature: "s", quote: {} }), { status: 201 }));
  const r = await createOneClick("https://1c.example", f).quote({ dry: true } as never);
  expect(r).toEqual({ signature: "s", quote: {} });
  expect(calls[0]).toEqual({ url: "https://1c.example/v0/quote", body: { dry: true } });
});
test("status maps 404 to not-found and passes the status through", async () => {
  const { f, calls } = fake((u) => (u.includes("missing") ? new Response("", { status: 404 }) : new Response(JSON.stringify({ status: "PROCESSING", swapDetails: {} }), { status: 200 })));
  const c = createOneClick("https://1c.example", f);
  expect(await c.status("missing")).toBe("not-found");
  expect(await c.status("0xabc")).toEqual({ status: "PROCESSING", raw: { status: "PROCESSING", swapDetails: {} } });
  expect(calls[1]!.url).toBe("https://1c.example/v0/status?depositAddress=0xabc");
});
test("failures are OneClickUnavailable with the API message", async () => {
  const { f } = fake(() => new Response(JSON.stringify({ message: "refundTo is not valid" }), { status: 400 }));
  await expect(createOneClick("https://1c.example", f).quote({} as never)).rejects.toEqual(new OneClickUnavailable("refundTo is not valid"));
  const down = fake(() => { throw new TypeError("network"); });
  await expect(createOneClick("https://1c.example", down.f).tokens()).rejects.toBeInstanceOf(OneClickUnavailable);
});
test("submit sends the tx hash and deposit address; tokens returns the list", async () => {
  const { f, calls } = fake((u) => new Response(u.endsWith("/tokens") ? JSON.stringify([{ assetId: "a" }]) : "{}", { status: 200 }));
  const c = createOneClick("https://1c.example", f);
  await c.submit("0xhash", "0xdeposit");
  expect(calls[0]).toEqual({ url: "https://1c.example/v0/deposit/submit", body: { txHash: "0xhash", depositAddress: "0xdeposit" } });
  expect(await c.tokens()).toEqual([{ assetId: "a" }]);
});
