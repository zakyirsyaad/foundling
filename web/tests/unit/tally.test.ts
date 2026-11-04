import { proofWord, replayWord } from "@/lib/proof/tally";

const clean = { pass: 5, skip: 0, fail: 0, state: "done" } as const;

test("Pass needs both tallies done and clean", () => {
  expect(proofWord(clean, clean)).toBe("Pass");
  expect(proofWord({ ...clean, skip: 1 }, clean)).toBe("Skip");
  expect(proofWord(clean, { ...clean, skip: 1 })).toBe("Skip");
  expect(proofWord(clean, null)).toBe("Checking");
  expect(proofWord({ ...clean, state: "running" }, clean)).toBe("Checking");
  expect(proofWord({ ...clean, state: "failed_to_build" }, clean)).toBe("Failed to build");
  expect(proofWord({ ...clean, fail: 1, skip: 1 }, clean)).toBe("Fail");
});
test("replay stays sealed before reveal_after", () => {
  expect(replayWord(1_000n, 999n, "skip")).toBe("Sealed");
  expect(replayWord(1_000n, 1_000n, "pass")).toBe("Pass");
  expect(replayWord(1_000n, 1_000n, "fail")).toBe("Fail");
  expect(replayWord(1_000n, 1_000n, "sealed")).toBe("Checking");
  expect(replayWord(1_000n, 1_000n, "skip")).toBe("Skip");
});
