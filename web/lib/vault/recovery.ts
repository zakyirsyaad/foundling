import type { Inflight, Policy, Stage } from "@/lib/chain/types";

export interface RecoveryActions {
  advance: boolean;
  abortStale: boolean;
  expireDecision: boolean;
  /** Chain time at which the next `advance` halts the vault (`stuck_since + halt_after`). */
  haltAt: bigint | null;
}

const NONE: RecoveryActions = { advance: false, abortStale: false, expireDecision: false, haltAt: null };

/**
 * Which recovery buttons are live, mirroring `stuck_swap` in recovery.rs. `chainTime` is the final
 * block's time in seconds and `height` its height; never the browser clock.
 */
export function recoveryAction(stage: Stage, inflight: Inflight | null, policy: Policy, chainTime: bigint, height: bigint): RecoveryActions {
  const timedOut = (enteredAt: bigint) => chainTime >= enteredAt + policy.stuckAfter;
  const advance = (since: bigint): RecoveryActions => ({ ...NONE, advance: true, haltAt: since + policy.haltAfter });
  switch (stage.kind) {
    case "Stuck":
      return advance(stage.since);
    case "Probing":
      return timedOut(stage.enteredAt) ? advance(stage.stuckSince) : NONE;
    case "Depositing":
    case "Swapping":
    case "Withdrawing":
      return timedOut(stage.enteredAt) ? advance(inflight?.stuckSince ?? stage.enteredAt) : NONE;
    case "AwaitingDecision":
    case "AwaitingPrice":
      return height >= stage.enteredBlock + policy.abortAfterBlocks ? { ...NONE, abortStale: true } : NONE;
    case "DecisionReady":
      return chainTime >= stage.expiresAt ? { ...NONE, expireDecision: true } : NONE;
    case "Idle":
      return NONE;
  }
}
