export interface ClockAnchor {
  /** `timestamp` of the signed quote, in ms. */
  responseTimestampMs: number;
  /** `performance.now()` when the answer arrived. */
  perfAtReceipt: number;
  /** `Date.now()` when the answer arrived. */
  dateAtReceipt: number;
}

/**
 * Time left before `deadline`, by two clocks: monotonic time since the answer, and the device clock
 * corrected by its offset to the quote's timestamp. The smaller one wins (WEBSITE §3 step 4).
 */
export function remainingMs(deadlineMs: number, a: ClockAnchor, nowPerf: number, nowDate: number): number {
  const byPerf = deadlineMs - (a.responseTimestampMs + (nowPerf - a.perfAtReceipt));
  const byDate = deadlineMs - (nowDate + (a.responseTimestampMs - a.dateAtReceipt));
  return Math.min(byPerf, byDate);
}

export type AddressView = "show" | "hide" | "do-not-send";
export type SwapStatus = "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "not-found" | "unknown" | "other";

/** Whether the deposit address may be shown. A 404 before 1Click knows the address counts as PENDING_DEPOSIT. */
export function addressView(i: { status: SwapStatus; remainingMs: number; marginMs: number; needsReanchor: boolean; reloaded: boolean }): AddressView {
  if (i.remainingMs <= i.marginMs) return "do-not-send";
  if (i.needsReanchor || i.reloaded) return "hide";
  return i.status === "PENDING_DEPOSIT" || i.status === "INCOMPLETE_DEPOSIT" || i.status === "not-found" ? "show" : "hide";
}
