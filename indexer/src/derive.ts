/** Rebuilds one cycle row from all of its events (WEBSITE §5). Pure: the same events always give the same row. */
import type { ParsedEvent } from "./parse";

/** Events that end a cycle. `rejected` closes too, except for PRICE_UNAVAILABLE, which keeps the decision for a retry. */
export const CLOSING = new Set(["executed", "swap_reverted", "hold", "cycle_failed", "cycle_aborted"]);
const REJECTED = "rejected";
const RETRYABLE_REJECTION = "PRICE_UNAVAILABLE";
/** These carry a cycle nonce but belong to an account, often long after the cycle ended. */
const NOT_CYCLE_EVENTS = new Set(["claimed"]);

export interface DerivedCycle {
  nonce: bigint;
  startedAt: Date;
  finishedAt: Date | null;
  closing: string | null;
  triggerTx: string | null;
  decisionTx: string | null;
  amountIn: bigint | null;
  amountOut: bigint | null;
  lastBlock: bigint;
}

export function cycleEvents(events: ParsedEvent[]): ParsedEvent[] {
  return events.filter((e) => e.nonce !== null && !NOT_CYCLE_EVENTS.has(e.name));
}

function closes(e: ParsedEvent): boolean {
  return CLOSING.has(e.name) || (e.name === REJECTED && e.data.code !== RETRYABLE_REJECTION);
}

function amount(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

function amounts(close: ParsedEvent | undefined): { amountIn: bigint | null; amountOut: bigint | null } {
  if (close?.name === "executed") return { amountIn: amount(close.data.amount_in), amountOut: amount(close.data.amount_out) };
  if (close?.name === "swap_reverted") return { amountIn: amount(close.data.amount), amountOut: null };
  return { amountIn: null, amountOut: null };
}

/** `events` are one nonce's events in chain order. */
export function deriveCycle(events: ParsedEvent[]): DerivedCycle {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last || first.nonce === null) throw new Error("deriveCycle needs at least one event with a nonce");
  const started = events.find((e) => e.name === "cycle_started");
  const close = events.find(closes);
  return {
    nonce: first.nonce,
    startedAt: (started ?? first).blockTime,
    finishedAt: close?.blockTime ?? null,
    closing: close?.name ?? null,
    triggerTx: started?.txHash ?? null,
    decisionTx: events.find((e) => e.name === "decision")?.txHash ?? null,
    ...amounts(close),
    lastBlock: last.blockHeight,
  };
}
