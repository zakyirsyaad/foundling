import { BACKOFF_MS, GIVE_UP_AFTER_MS, nextAttempt, parseSummary, replayResult, runTool } from "../src/proofs/run";

test("parseSummary reads the SUMMARY line", () => {
  expect(parseSummary("PASS a\nSKIP b: x\nSUMMARY pass=6 skip=1 fail=0\n")).toEqual({ pass: 6, skip: 1, fail: 0 });
});

test("output without SUMMARY gives null", () => {
  expect(parseSummary("thread main panicked\n")).toBeNull();
  expect(parseSummary("")).toBeNull();
});

test.each([
  ["SKIP cycle 3 replay: needs the revealed parameters", "skip"],
  ["PASS cycle 3 replay", "pass"],
  ["FAIL cycle 3 replay: decision differs", "fail"],
  ["PASS cycle 3 quote\nSUMMARY pass=1 skip=0 fail=0", null],
])("replayResult(%j) is %s", (out, want) => {
  expect(replayResult(out)).toBe(want);
});

test("a later failing replay line wins over an earlier pass", () => {
  expect(replayResult("PASS cycle 1 replay\nFAIL cycle 2 replay: differs")).toBe("fail");
});

test("backoff is 5, 15, 60, 180, then 360 minutes, and gives up at 24 hours", () => {
  expect(BACKOFF_MS).toEqual([5, 15, 60, 180, 360].map((m) => m * 60_000));
  expect(GIVE_UP_AFTER_MS).toBe(86_400_000);
  const t0 = new Date(0);
  expect([0, 1, 2, 3, 4, 9].map((a) => nextAttempt(t0, a).getTime() / 60_000)).toEqual([5, 15, 60, 180, 360, 360]);
});

test("runTool returns the exit code and stdout", async () => {
  const r = await runTool("/bin/sh", ["-c", "echo hi; exit 3"], 2000);
  expect(r).toEqual({ code: 3, stdout: "hi\n", timedOut: false });
});

test("runTool kills a tool that runs past its timeout", async () => {
  const started = Date.now();
  const r = await runTool("/bin/sh", ["-c", "sleep 10"], 200);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("runTool reports a missing program as a failure, not a throw", async () => {
  const r = await runTool("/no/such/tool", [], 1000);
  expect(r.code).toBeNull();
  expect(r.timedOut).toBe(false);
});

test("a failed run is described with the tool's last stderr line", async () => {
  const { describeRun } = await import("../src/proofs/run");
  const r = await runTool("/bin/sh", ["-c", "echo working; echo 'error: the vault is revealed, so pass --reveal-tx' >&2; exit 2"], 2000);
  expect(describeRun("fetch_proof.py", r, 2000)).toBe("fetch_proof.py exit 2: error: the vault is revealed, so pass --reveal-tx");
});

test("runTool hands a tool the env it is given and keeps the archive key from every other tool", async () => {
  process.env.NEARAI_ARCHIVE_KEY = "from-the-worker";
  try {
    const plain = await runTool("/bin/sh", ["-c", "echo ${NEARAI_ARCHIVE_KEY:-none} ${X:-unset}"], 2000, { X: "given" });
    expect(plain.stdout.trim()).toBe("none given");
    const handed = await runTool("/bin/sh", ["-c", "echo ${NEARAI_ARCHIVE_KEY:-none}"], 2000, { NEARAI_ARCHIVE_KEY: "handed" });
    expect(handed.stdout.trim()).toBe("handed");
  } finally {
    delete process.env.NEARAI_ARCHIVE_KEY;
  }
});
