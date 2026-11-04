import { parseInflight, parsePolicy, parseStage } from "@/lib/chain/types";
import { inflightJson, policyJson } from "../fixtures/vault";

test("parses every stage the contract serializes", () => {
  expect(parseStage("Idle")).toEqual({ kind: "Idle" });
  expect(parseStage({ AwaitingDecision: { nonce: 3, entered_block: 100 } })).toEqual({ kind: "AwaitingDecision", nonce: 3n, enteredBlock: 100n });
  expect(parseStage({ DecisionReady: { nonce: 3, expires_at: 1800000300 } })).toEqual({ kind: "DecisionReady", nonce: 3n, expiresAt: 1800000300n });
  expect(parseStage({ AwaitingPrice: { nonce: 3, entered_block: 100, expires_at: 9 } })).toEqual({ kind: "AwaitingPrice", nonce: 3n, enteredBlock: 100n, expiresAt: 9n });
  expect(parseStage({ Depositing: { nonce: 3, attempt: 0, entered_at: 5 } })).toEqual({ kind: "Depositing", nonce: 3n, attempt: 0, enteredAt: 5n });
  expect(parseStage({ Swapping: { nonce: 3, attempt: 1, entered_at: 5 } })).toEqual({ kind: "Swapping", nonce: 3n, attempt: 1, enteredAt: 5n });
  expect(parseStage({ Withdrawing: { nonce: 3, attempt: 2, entered_at: 5, unwinding: true, token: "Wnear", amount: "7" } }))
    .toEqual({ kind: "Withdrawing", nonce: 3n, attempt: 2, enteredAt: 5n, unwinding: true, token: "Wnear", amount: 7n });
  expect(parseStage({ Stuck: { nonce: 7, step: "Swap", attempt: 2, since: 1800000000 } }))
    .toEqual({ kind: "Stuck", nonce: 7n, step: "Swap", attempt: 2, since: 1800000000n });
  expect(parseStage({ Probing: { nonce: 7, step: "Withdraw", attempt: 2, stuck_since: 10, entered_at: 20 } }))
    .toEqual({ kind: "Probing", nonce: 7n, step: "Withdraw", attempt: 2, stuckSince: 10n, enteredAt: 20n });
});
test("an unknown stage is an error, not Idle", () => {
  expect(() => parseStage({ Exploded: {} })).toThrow();
  expect(() => parseStage("Busy")).toThrow();
});
test("policy keeps every field with exact types", () => {
  const p = parsePolicy(policyJson);
  expect(p.perUserCap).toBe(100_000_000n);
  expect(p.stuckAfter).toBe(900n);
  expect(p.capBps).toBe(2500);
  expect(p.openDeposits).toBe(true);
  expect(parsePolicy({ ...policyJson, open_deposits: undefined }).openDeposits).toBe(false);
});
test("inflight parses or is null", () => {
  expect(parseInflight(null)).toBeNull();
  expect(parseInflight(inflightJson)).toMatchObject({ nonce: 9n, tokenIn: "Usdc", amountOut: null, stuckSince: 1000n });
});
