import { type FlowState, flowReducer, initialFlow } from "@/lib/crosschain/flow";

const swap = { depositAddress: "0xdep", recipient: "alice.near", chainId: "base" as const, deadlineMs: 10, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false };

test("connecting binds the flow to the account and moves to quote", () => {
  expect(flowReducer(initialFlow, { type: "connected", account: "alice.near" })).toEqual({ ...initialFlow, step: "quote", boundAccount: "alice.near" });
});
test("an account change before the address shows sends the flow back to quote", () => {
  let s: FlowState = flowReducer(initialFlow, { type: "connected", account: "alice.near" });
  s = flowReducer(s, { type: "quoted", chain: "base" });
  s = flowReducer(s, { type: "prepared" });
  expect(s.step).toBe("send");
  s = flowReducer(s, { type: "account-changed", account: "bob.near" });
  expect(s).toMatchObject({ step: "quote", boundAccount: "bob.near", chain: null });
});
test("after the address shows, the swap stays with its account", () => {
  let s: FlowState = flowReducer(initialFlow, { type: "connected", account: "alice.near" });
  s = flowReducer(flowReducer(flowReducer(s, { type: "quoted", chain: "base" }), { type: "prepared" }), { type: "address-verified", swap });
  expect(s).toMatchObject({ step: "send", addressShown: true, swap });
  s = flowReducer(s, { type: "account-changed", account: "bob.near" });
  expect(s).toMatchObject({ boundAccount: "alice.near", swap });
  expect(flowReducer(s, { type: "account-changed", account: null }).boundAccount).toBe("alice.near");
});
test("a final status moves to wait; a problem is shown and cleared on the next step", () => {
  let s: FlowState = { ...initialFlow, step: "send", boundAccount: "alice.near", swap, addressShown: true };
  s = flowReducer(s, { type: "status", status: "PROCESSING" });
  expect(s.step).toBe("wait");
  expect(flowReducer(s, { type: "problem", message: "x" }).problem).toBe("x");
  expect(flowReducer({ ...s, problem: "x" }, { type: "quoted", chain: "arb" }).problem).toBeNull();
});
test("reset starts over for the same account", () => {
  const s: FlowState = { ...initialFlow, step: "wait", boundAccount: "alice.near", swap, addressShown: true };
  expect(flowReducer(s, { type: "reset" })).toEqual({ ...initialFlow, step: "quote", boundAccount: "alice.near" });
});
test("a 404 or an unknown status keeps the flow at send, like PENDING_DEPOSIT", () => {
  const s: FlowState = { ...initialFlow, step: "send", boundAccount: "alice.near", swap, addressShown: true };
  for (const status of ["not-found", "unknown", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT"]) expect(flowReducer(s, { type: "status", status }).step).toBe("send");
  for (const status of ["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"]) expect(flowReducer(s, { type: "status", status }).step).toBe("wait");
});
