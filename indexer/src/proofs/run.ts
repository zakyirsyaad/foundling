/** Running the proof tools and reading what they print (WEBSITE §5 "Worker: antrean bukti"). */
import { spawn } from "node:child_process";

export interface Counts { pass: number; skip: number; fail: number }
export interface Tally extends Counts { state: "queued" | "running" | "done" | "failed_to_build" }

export const BACKOFF_MS = [5, 15, 60, 180, 360].map((m) => m * 60_000);
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;
export const TOOL_TIMEOUT_MS = 120_000;
/** Tool output past this is dropped: only the SUMMARY and check lines matter. */
const MAX_STDOUT = 1_000_000;
const MAX_STDERR = 4_000;

const SUMMARY = /^SUMMARY pass=(\d+) skip=(\d+) fail=(\d+)\s*$/m;
const REPLAY = /^(PASS|SKIP|FAIL) .* replay(?::.*)?$/gm;

/** The exit code stays 0 with skips, so the tally comes from this line, never from the code. */
export function parseSummary(stdout: string): Counts | null {
  const m = SUMMARY.exec(stdout);
  return m ? { pass: Number(m[1]), skip: Number(m[2]), fail: Number(m[3]) } : null;
}

/** Any failed replay fails; otherwise any skipped one skips; otherwise pass. Null when no replay line was printed. */
export function replayResult(stdout: string): "pass" | "fail" | "skip" | null {
  const words = [...stdout.matchAll(REPLAY)].map((m) => m[1]);
  if (words.length === 0) return null;
  if (words.includes("FAIL")) return "fail";
  if (words.includes("SKIP")) return "skip";
  return "pass";
}

export function nextAttempt(now: Date, attemptsSoFar: number): Date {
  const delay = BACKOFF_MS[Math.min(attemptsSoFar, BACKOFF_MS.length - 1)]!;
  return new Date(now.getTime() + delay);
}

/** `stderr` is kept only as a short tail, for the reason in `last_error`. */
export interface ToolRun { code: number | null; stdout: string; timedOut: boolean; stderr?: string }

/** The NEAR AI key the worker archives signatures with. Only fetch_proof.py is handed it. */
export const ARCHIVE_KEY_ENV = "NEARAI_ARCHIVE_KEY";

/** The worker's env without the archive key, plus `extra`. */
function toolEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const { [ARCHIVE_KEY_ENV]: _held, ...rest } = process.env;
  return { ...rest, ...extra };
}

/**
 * Never throws. The tool runs in its own process group so a timeout also kills whatever it started. A tool gets
 * the worker's env without the archive key, plus `env`.
 */
export function runTool(cmd: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<ToolRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stderr ? { code, stdout, timedOut, stderr } : { code, stdout, timedOut });
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: toolEnv(env) });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(null));
    // 'close' comes after stdout and stderr have drained; 'exit' can come first, and the SUMMARY or the
    // stderr tail would be lost (seen on Linux CI). A timeout has already finished above.
    child.on("close", (code) => finish(code));
  });
}

export function describeRun(tool: string, r: ToolRun, timeoutMs: number): string {
  if (r.timedOut) return `${tool} timed out after ${timeoutMs} ms`;
  if (r.code === null) return `${tool} could not start`;
  const last = (r.stderr?.trim() || r.stdout.trim()).split("\n").pop() ?? "";
  return `${tool} exit ${r.code}${last ? `: ${last.slice(0, 300)}` : ""}`;
}
