import { parseInflight, parsePolicy, type Stage } from "@/lib/chain/types";
import { recoveryAction } from "@/lib/vault/recovery";
import { inflightJson, policyJson } from "../fixtures/vault";

const policy = { ...parsePolicy(policyJson), stuckAfter: 40n, haltAfter: 600n, abortAfterBlocks: 300n };
const inflight = parseInflight(inflightJson)!;
const none = { advance: false, abortStale: false, expireDecision: false, haltAt: null };

test("a retried Withdrawing keeps the first stall for the halt clock", () => {
  const stage: Stage = { kind: "Withdrawing", nonce: 9n, attempt: 2, enteredAt: 2_000n, unwinding: false, token: "Usdc", amount: 1n };
  expect(recoveryAction(stage, { ...inflight, stuckSince: 1_000n }, policy, 2_040n, 0n)).toEqual({ advance: true, abortStale: false, expireDecision: false, haltAt: 1_600n });
});
test("a first stall starts the halt clock at entered_at", () => {
  const stage: Stage = { kind: "Depositing", nonce: 9n, attempt: 0, enteredAt: 2_000n };
  expect(recoveryAction(stage, { ...inflight, stuckSince: null }, policy, 2_040n, 0n)).toEqual({ advance: true, abortStale: false, expireDecision: false, haltAt: 2_600n });
});
test("nothing is offered before stuck_after", () => {
  const stage: Stage = { kind: "Swapping", nonce: 9n, attempt: 0, enteredAt: 2_000n };
  expect(recoveryAction(stage, inflight, policy, 2_039n, 0n)).toEqual(none);
});
test("Stuck always allows advance, clocked from since", () => {
  const stage: Stage = { kind: "Stuck", nonce: 9n, step: "Swap", attempt: 1, since: 1_500n };
  expect(recoveryAction(stage, inflight, policy, 1_501n, 0n)).toEqual({ advance: true, abortStale: false, expireDecision: false, haltAt: 2_100n });
});
test("Probing past stuck_after allows advance, clocked from stuck_since", () => {
  const stage: Stage = { kind: "Probing", nonce: 9n, step: "Withdraw", attempt: 1, stuckSince: 900n, enteredAt: 2_000n };
  expect(recoveryAction(stage, inflight, policy, 2_040n, 0n)).toEqual({ advance: true, abortStale: false, expireDecision: false, haltAt: 1_500n });
  expect(recoveryAction(stage, inflight, policy, 2_039n, 0n)).toEqual(none);
});
test("awaiting stages abort after abort_after_blocks", () => {
  const awaiting: Stage = { kind: "AwaitingDecision", nonce: 9n, enteredBlock: 100n };
  expect(recoveryAction(awaiting, null, policy, 0n, 399n)).toEqual(none);
  expect(recoveryAction(awaiting, null, policy, 0n, 400n)).toEqual({ ...none, abortStale: true });
  const price: Stage = { kind: "AwaitingPrice", nonce: 9n, enteredBlock: 100n, expiresAt: 5n };
  expect(recoveryAction(price, null, policy, 0n, 400n)).toEqual({ ...none, abortStale: true });
});
test("a ready decision expires at expires_at", () => {
  const stage: Stage = { kind: "DecisionReady", nonce: 9n, expiresAt: 3_000n };
  expect(recoveryAction(stage, null, policy, 2_999n, 0n)).toEqual(none);
  expect(recoveryAction(stage, null, policy, 3_000n, 0n)).toEqual({ ...none, expireDecision: true });
});
test("Idle offers nothing", () => {
  expect(recoveryAction({ kind: "Idle" }, null, policy, 10n ** 12n, 10n ** 12n)).toEqual(none);
});
