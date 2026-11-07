import type { CycleRow } from "@/lib/history/client";
import { KNOWN_EVENTS } from "@/lib/cycles/events";
import { cycleWord, filterCycles } from "@/lib/cycles/outcome";

const ev = (...names: (string | [string, string])[]) => names.map((n) => (Array.isArray(n) ? { name: n[0], code: n[1] } : { name: n }));

test("PRICE_UNAVAILABLE does not end a cycle", () => {
  expect(cycleWord(ev("cycle_started", ["rejected", "PRICE_UNAVAILABLE"]))).toBe("Running");
  expect(cycleWord(ev("cycle_started", ["rejected", "OVER_CAP"]))).toBe("Rejected");
});
test("each closing event has its word", () => {
  expect(cycleWord(ev("cycle_started", "decision", "executed"))).toBe("Executed");
  expect(cycleWord(ev("cycle_started", "swap_reverted"))).toBe("Reversed");
  expect(cycleWord(ev("cycle_started", ["hold", "NO_DECISION"]))).toBe("Hold");
  expect(cycleWord(ev("cycle_started", ["cycle_failed", "NULL_RESULT"]))).toBe("Failed");
  expect(cycleWord(ev("cycle_started", "cycle_aborted"))).toBe("Aborted");
});
test("stuck and probing keep a cycle open", () => {
  expect(cycleWord(ev("cycle_started", "stuck"))).toBe("Stuck");
  expect(cycleWord(ev("cycle_started", "stuck", "probing"))).toBe("Stuck");
  expect(cycleWord(ev("cycle_started", "decision"))).toBe("Running");
  expect(cycleWord(ev("cycle_started", "stuck", "probing", "executed"))).toBe("Executed");
});
test("filters by the closing word", () => {
  const row = (nonce: bigint, ...names: string[]): CycleRow => ({ nonce, startedAt: "", finishedAt: null, events: ev(...names), amountIn: null, amountOut: null, txHashes: [], verifier: null, obsRecheck: null });
  const rows = [row(3n, "executed"), row(2n, "hold"), row(1n, "cycle_failed")];
  expect(filterCycles(rows, "all").map((r) => r.nonce)).toEqual([3n, 2n, 1n]);
  expect(filterCycles(rows, "executed").map((r) => r.nonce)).toEqual([3n]);
  expect(filterCycles(rows, "hold").map((r) => r.nonce)).toEqual([2n]);
  expect(filterCycles(rows, "other").map((r) => r.nonce)).toEqual([1n]);
});
test("the known events are the ones the contract emits", () => {
  expect(KNOWN_EVENTS).toContain("claim_folded");
  expect(new Set(KNOWN_EVENTS).size).toBe(KNOWN_EVENTS.length);
});

import { eventMark } from "@/lib/cycles/outcome";

test("a timeline mark is a check only for steps that went through", () => {
  expect(eventMark({ name: "executed" })).toBe("done");
  expect(eventMark({ name: "decision" })).toBe("done");
  for (const name of ["rejected", "swap_reverted", "cycle_failed", "cycle_aborted", "stuck"]) expect(eventMark({ name })).toBe("stop");
  expect(eventMark({ name: "hold" })).toBe("wait");
  expect(eventMark({ name: "probing" })).toBe("wait");
});
