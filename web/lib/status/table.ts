export type StatusGroup = "cycle" | "proof" | "vault" | "oneclick";
export type Tone = "success" | "warning" | "danger" | "neutral";

/** The one source of status words and their colours (WEBSITE §4, Status table). */
export const STATUS: Readonly<Record<StatusGroup, Readonly<Record<string, Tone>>>> = Object.freeze({
  cycle: Object.freeze({ Executed: "success", Reversed: "warning", Rejected: "warning", Stuck: "warning", Failed: "danger", Hold: "neutral", Aborted: "neutral", Running: "neutral" }),
  proof: Object.freeze({ Pass: "success", Skip: "warning", Fail: "danger", "Failed to build": "danger", Checking: "neutral", Sealed: "neutral" }),
  vault: Object.freeze({ Live: "success", Stuck: "warning", Halted: "danger", Frozen: "neutral", "Not ready": "neutral" }),
  oneclick: Object.freeze({ SUCCESS: "success", INCOMPLETE_DEPOSIT: "warning", REFUNDED: "warning", FAILED: "danger", PENDING_DEPOSIT: "neutral", KNOWN_DEPOSIT_TX: "neutral", PROCESSING: "neutral" }),
});

export function toneOf(group: StatusGroup, word: string): Tone {
  const tone = STATUS[group][word];
  if (!tone) throw new Error(`"${word}" is not a ${group} status word`);
  return tone;
}
