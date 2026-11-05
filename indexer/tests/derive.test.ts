import { CLOSING, cycleEvents, deriveCycle } from "../src/derive";
import type { ParsedEvent } from "../src/parse";

let seq = 0;
function e(name: string, data: Record<string, unknown> = {}, at: { tx?: string; block?: number } = {}): ParsedEvent {
  seq++;
  const block = BigInt(at.block ?? 100 + seq);
  return {
    vaultId: "v.testnet", receiptId: `R${seq}`, logIndex: 0, txHash: at.tx ?? `TX${seq}`, blockHeight: block, receiptIndex: 0,
    blockTime: new Date(Number(block) * 1000), name, nonce: 4n, account: null, data: { nonce: 4, ...data },
  };
}

test("an executed cycle closes with its amounts and transactions", () => {
  const evs = [e("cycle_started", {}, { tx: "T1", block: 10 }), e("decision", {}, { tx: "T2", block: 12 }), e("decision_ready", {}, { tx: "T2", block: 12 }), e("swap_started", {}, { block: 13 }), e("executed", { amount_in: "100", amount_out: "47" }, { tx: "T9", block: 20 })];
  expect(deriveCycle(evs)).toEqual({
    nonce: 4n, startedAt: new Date(10_000), finishedAt: new Date(20_000), closing: "executed",
    triggerTx: "T1", decisionTx: "T2", amountIn: 100n, amountOut: 47n, lastBlock: 20n,
  });
});

test("the decision may come in a later transaction than the trigger", () => {
  const c = deriveCycle([e("cycle_started", {}, { tx: "T1", block: 10 }), e("decision", {}, { tx: "T7", block: 210 })]);
  expect(c).toMatchObject({ triggerTx: "T1", decisionTx: "T7", closing: null, finishedAt: null, lastBlock: 210n });
});

test("a rejection for PRICE_UNAVAILABLE keeps the cycle open", () => {
  const c = deriveCycle([e("cycle_started"), e("rejected", { code: "PRICE_UNAVAILABLE" })]);
  expect(c.closing).toBeNull();
  expect(c.finishedAt).toBeNull();
});

test("a rejection for OVER_CAP closes the cycle", () => {
  const c = deriveCycle([e("cycle_started"), e("rejected", { code: "OVER_CAP" }, { block: 300 })]);
  expect(c).toMatchObject({ closing: "rejected", finishedAt: new Date(300_000) });
});

test("a reverted swap records what went in and nothing out", () => {
  const c = deriveCycle([e("cycle_started"), e("swap_reverted", { amount: "100" })]);
  expect(c).toMatchObject({ closing: "swap_reverted", amountIn: 100n, amountOut: null });
});

test.each([...CLOSING])("%s closes a cycle", (name) => {
  expect(deriveCycle([e("cycle_started"), e(name)]).closing).toBe(name);
});

test("hold closes without amounts", () => {
  expect(deriveCycle([e("cycle_started"), e("hold", { code: "NO_DECISION" })])).toMatchObject({ closing: "hold", amountIn: null, amountOut: null });
});

test("without cycle_started the first event gives the start and there is no trigger", () => {
  const c = deriveCycle([e("decision", {}, { tx: "T5", block: 50 })]);
  expect(c).toMatchObject({ startedAt: new Date(50_000), triggerTx: null, decisionTx: "T5" });
});

test("an empty list is refused", () => {
  expect(() => deriveCycle([])).toThrow();
});

test("claims carry a cycle nonce but are not part of the cycle", () => {
  const evs = [e("cycle_started"), e("claimed", { account: "bob.testnet", amount: "5" }), e("deposit_queued")];
  evs[2] = { ...evs[2]!, nonce: null };
  expect(cycleEvents(evs).map((x) => x.name)).toEqual(["cycle_started"]);
});

test("describeError reports the innermost cause, not the wrapped query", async () => {
  const { describeError } = await import("../src/loop");
  const wrapped = new Error("Failed query: insert into cycles params: 1,2,3", { cause: new Error("injected failure") });
  expect(describeError(wrapped)).toBe("Error: injected failure");
  expect(describeError("plain")).toBe("plain");
  expect(describeError(new Error("x".repeat(5000)))).toHaveLength(2000);
});

test("the last closing event wins, as on the website (web/lib/cycles/outcome.ts)", () => {
  const c = deriveCycle([e("cycle_started"), e("rejected", { code: "OVER_CAP" }, { block: 400 }), e("cycle_aborted", {}, { block: 500 })]);
  expect(c).toMatchObject({ closing: "cycle_aborted", finishedAt: new Date(500_000) });
});

test("claim_folded also carries an old cycle's nonce and is not part of that cycle", () => {
  const evs = [e("cycle_started"), e("claim_folded", { account: "bob.testnet", amount: "5" })];
  expect(cycleEvents(evs).map((x) => x.name)).toEqual(["cycle_started"]);
});
