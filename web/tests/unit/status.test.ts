import { STATUS, toneOf } from "@/lib/status/table";

test("the status table is the one in WEBSITE §4", () => {
  expect(STATUS.cycle).toEqual({ Executed: "success", Reversed: "warning", Rejected: "warning", Stuck: "warning", Failed: "danger", Hold: "neutral", Aborted: "neutral", Running: "neutral" });
  expect(STATUS.proof).toEqual({ Pass: "success", Skip: "warning", Fail: "danger", "Failed to build": "danger", Checking: "neutral", Sealed: "neutral" });
  expect(STATUS.vault).toEqual({ Live: "success", Stuck: "warning", Halted: "danger", Frozen: "neutral", "Not ready": "neutral" });
  expect(STATUS.oneclick).toEqual({ SUCCESS: "success", INCOMPLETE_DEPOSIT: "warning", REFUNDED: "warning", FAILED: "danger", PENDING_DEPOSIT: "neutral", KNOWN_DEPOSIT_TX: "neutral", PROCESSING: "neutral" });
});
test("unknown words are a bug, not a grey chip", () => {
  expect(toneOf("vault", "Halted")).toBe("danger");
  expect(() => toneOf("cycle", "Pass")).toThrow();
});
