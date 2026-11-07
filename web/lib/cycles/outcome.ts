import type { CycleFilter, CycleRow } from "@/lib/history/client";

export type CycleWord = "Executed" | "Reversed" | "Hold" | "Rejected" | "Failed" | "Aborted" | "Running" | "Stuck";
type Event = { name: string; code?: string };

/** Only these events end a cycle (WEBSITE §3 Siklus). `rejected` with PRICE_UNAVAILABLE goes back to DecisionReady. */
function closingWord(e: Event): CycleWord | null {
  switch (e.name) {
    case "executed":
      return "Executed";
    case "swap_reverted":
      return "Reversed";
    case "hold":
      return "Hold";
    case "rejected":
      return e.code === "PRICE_UNAVAILABLE" ? null : "Rejected";
    case "cycle_failed":
      return "Failed";
    case "cycle_aborted":
      return "Aborted";
    default:
      return null;
  }
}

export type EventMark = "done" | "stop" | "wait";

const STOP_EVENTS = new Set(["rejected", "swap_reverted", "cycle_failed", "cycle_aborted", "stuck"]);
const WAIT_EVENTS = new Set(["hold", "probing"]);

/** The timeline mark for one event: a check only for a step that went through. */
export function eventMark(e: Event): EventMark {
  if (STOP_EVENTS.has(e.name)) return "stop";
  return WAIT_EVENTS.has(e.name) ? "wait" : "done";
}

export function cycleWord(events: readonly Event[]): CycleWord {
  for (let i = events.length - 1; i >= 0; i--) {
    const word = closingWord(events[i]!);
    if (word) return word;
  }
  const last = [...events].reverse().find((e) => e.name === "stuck" || e.name === "probing" || closingWord(e) !== null || e.name === "decision");
  return last && (last.name === "stuck" || last.name === "probing") ? "Stuck" : "Running";
}

export function filterCycles(rows: readonly CycleRow[], f: CycleFilter): CycleRow[] {
  if (f === "all") return [...rows];
  return rows.filter((r) => {
    const w = cycleWord(r.events);
    if (f === "executed") return w === "Executed";
    if (f === "hold") return w === "Hold";
    return w !== "Executed" && w !== "Hold";
  });
}
