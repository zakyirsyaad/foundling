import type { Tally } from "@/lib/history/client";

export type ProofWord = "Pass" | "Skip" | "Fail" | "Failed to build" | "Checking";

/** Pass only when the verifier and the obs recheck both ran with no skip and no fail (WEBSITE §3 Bukti). */
export function proofWord(verifier: Tally | null, obs: Tally | null): ProofWord {
  const tallies = [verifier, obs];
  if (tallies.some((t) => t?.state === "failed_to_build")) return "Failed to build";
  if (tallies.some((t) => t && t.fail > 0)) return "Fail";
  if (tallies.some((t) => t === null || t.state !== "done")) return "Checking";
  if (tallies.some((t) => t!.skip > 0)) return "Skip";
  return "Pass";
}

/** Replay is sealed until `reveal_after`; after it, the worker's re-verification decides. */
export function replayWord(revealAfter: bigint, chainTime: bigint, replay: "sealed" | "pass" | "fail" | "skip"): "Sealed" | "Pass" | "Fail" | "Skip" | "Checking" {
  if (chainTime < revealAfter) return "Sealed";
  if (replay === "sealed") return "Checking";
  return replay === "pass" ? "Pass" : replay === "fail" ? "Fail" : "Skip";
}
