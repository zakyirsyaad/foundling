/** The proof queue: one cycle at a time, with backoff and final states, apart from the index round. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, cycles, events, proofs } from "@foundling/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Fastnear } from "../fastnear";
import { describeError } from "../loop";
import type { ArchivalRpc } from "../rpc";
import { type Counts, GIVE_UP_AFTER_MS, describeRun, nextAttempt, parseSummary, replayResult, runTool } from "./run";

export interface ToolPaths {
  python: string;
  fetchProof: string;
  recheckObs: string;
  /** foundling-verify built with `--features fetch`; also fetch_proof's --collateral-bin. */
  verify: string;
  /** Archival RPCs handed to fetch_proof.py as --rpc, for backlogs older than regular nodes keep. */
  rpcUrls: string[];
  timeoutMs: number;
}

export interface ProofDeps {
  db: Db;
  vaultId: string;
  chain: "mainnet" | "testnet";
  obsSource: "live" | "rehearsal";
  tools: ToolPaths;
  rpc: Pick<ArchivalRpc, "viewAt" | "tip">;
  /** Finds the reveal transaction's signer, which fetch_proof.py needs to read its log. */
  fastnear: Pick<Fastnear, "transactions">;
  now: () => Date;
  verifierCommit?: string;
}

type ProofRow = typeof proofs.$inferSelect;
type Bundle = Record<string, unknown> & { opening?: { params: string; salt: string }; approved_measurements?: unknown };

const SKIPPED: Counts = { pass: 0, skip: 1, fail: 0 };
const RECHECK_FAILED = 1;
const SOURCE_DOWN = 2;

function parseBundle(text: string): Bundle | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Bundle) : null;
  } catch {
    return null;
  }
}

interface Reveal { txHash: string; salt: string }

/** The vault's own `revealed` log, as stored by the index round. */
async function storedReveal(deps: ProofDeps): Promise<Reveal | null> {
  const [r] = await deps.db.select({ txHash: events.txHash, data: events.data }).from(events).where(and(eq(events.vaultId, deps.vaultId), eq(events.name, "revealed"))).limit(1);
  const salt = (r?.data as { salt?: unknown } | undefined)?.salt;
  return r && typeof salt === "string" ? { txHash: r.txHash, salt } : null;
}

async function dueRow(deps: ProofDeps, revealed: boolean): Promise<ProofRow | undefined> {
  const open = sql`(${proofs.verifierState} in ('queued', 'running') or ${proofs.obsState} <> 'done'
    or (${revealed} and ${proofs.revealedApplied} = 0 and ${proofs.bundle} is not null and ${proofs.verifierState} = 'done'))`;
  const [row] = await deps.db
    .select()
    .from(proofs)
    .where(and(eq(proofs.vaultId, deps.vaultId), lte(proofs.nextAttemptAt, deps.now()), open))
    .orderBy(asc(proofs.nextAttemptAt), asc(proofs.nonce))
    .limit(1);
  return row;
}

async function triggerOf(deps: ProofDeps, nonce: bigint): Promise<string | null> {
  const [c] = await deps.db.select({ t: cycles.triggerTx }).from(cycles).where(and(eq(cycles.vaultId, deps.vaultId), eq(cycles.nonce, nonce)));
  return c?.t ?? null;
}

/**
 * The parameters come from the `revealed` view and the salt from the stored `revealed` log. Vaults built
 * before the `revealed_salt` view existed (every testnet vault so far) have only the log. The verifier checks
 * the pair against the commitment either way.
 */
async function openingOf(deps: ProofDeps, reveal: Reveal): Promise<{ params: string; salt: string } | null> {
  const tip = await deps.rpc.tip();
  const params = await deps.rpc.viewAt<string | null>(tip, deps.vaultId, "revealed", {});
  return typeof params === "string" ? { params, salt: reveal.salt } : null;
}

async function revealArgs(deps: ProofDeps, reveal: Reveal | null): Promise<string[]> {
  if (!reveal) return [];
  const [tx] = await deps.fastnear.transactions([reveal.txHash]);
  const signer = (tx?.transaction as { signer_id?: unknown } | undefined)?.signer_id;
  if (typeof signer !== "string") throw new Error(`FastNEAR has no signer for reveal tx ${reveal.txHash}`);
  return ["--reveal-tx", reveal.txHash, "--reveal-signer", signer];
}

/** Works one due proof as far as it can go. False when nothing is due. */
export async function processOne(deps: ProofDeps): Promise<boolean> {
  const reveal = await storedReveal(deps);
  const row = await dueRow(deps, reveal !== null);
  if (!row) return false;
  const now = deps.now();
  const base = { firstAttemptAt: row.firstAttemptAt ?? now };
  const where = and(eq(proofs.vaultId, deps.vaultId), eq(proofs.nonce, row.nonce));

  const trigger = await triggerOf(deps, row.nonce);
  if (!trigger) {
    await deps.db.update(proofs).set({ ...base, verifierState: "failed_to_build", obsState: "done", obsRecheck: SKIPPED, lastError: "no trigger transaction indexed for this cycle" }).where(where);
    return true;
  }

  const dir = mkdtempSync(join(tmpdir(), "foundling-proof-"));
  try {
    const s = await work(deps, row, reveal, trigger, dir);
    const expired = now.getTime() - base.firstAttemptAt.getTime() >= GIVE_UP_AFTER_MS;
    if (s.problem && expired) {
      if (s.verifierState !== "done") s.verifierState = "failed_to_build";
      if (s.obsState !== "done") Object.assign(s, { obsState: "done", obsRecheck: SKIPPED });
    }
    const retry = s.problem !== null && !expired;
    await deps.db
      .update(proofs)
      .set({
        ...base,
        bundle: s.bundle ? JSON.stringify(s.bundle) : null, approvedMeasurements: s.bundle?.approved_measurements ?? null,
        verifier: s.verifier, verifierState: s.verifierState, obsRecheck: s.obsRecheck, obsState: s.obsState,
        replay: s.replay, revealedApplied: s.revealedApplied, verifierCommit: s.verifierCommit,
        attempts: retry ? row.attempts + 1 : row.attempts,
        nextAttemptAt: retry ? nextAttempt(now, row.attempts) : now,
        lastError: s.problem,
      })
      .where(where);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface WorkState {
  bundle: Bundle | null;
  verifier: unknown;
  verifierState: string;
  obsRecheck: unknown;
  obsState: string;
  replay: string;
  revealedApplied: number;
  verifierCommit: string | null;
  problem: string | null;
}

async function work(deps: ProofDeps, row: ProofRow, reveal: Reveal | null, trigger: string, dir: string): Promise<WorkState> {
  const { tools } = deps;
  const s: WorkState = {
    bundle: row.bundle === null ? null : parseBundle(row.bundle), verifier: row.verifier, verifierState: row.verifierState, obsRecheck: row.obsRecheck,
    obsState: row.obsState, replay: row.replay, revealedApplied: row.revealedApplied, verifierCommit: row.verifierCommit, problem: null,
  };
  const file = join(dir, "proof.json");

  if (!s.bundle) {
    const rpcArgs = tools.rpcUrls.flatMap((u) => ["--rpc", u]);
    const extra = [...rpcArgs, ...(await revealArgs(deps, reveal))];
    const r = await runTool(tools.python, [tools.fetchProof, "--chain", deps.chain, "--vault", deps.vaultId, "--collateral-bin", tools.verify, "--out", file, ...extra, trigger], tools.timeoutMs);
    if (r.code !== 0 || r.timedOut) {
      s.problem = describeRun("fetch_proof.py", r, tools.timeoutMs);
      return s;
    }
    const parsed = parseBundle(readFileSync(file, "utf8"));
    if (!parsed) {
      s.problem = "fetch_proof.py wrote a bundle that is not readable JSON";
      return s;
    }
    s.bundle = parsed;
  }

  let verify = s.verifierState !== "done" && s.verifierState !== "failed_to_build";
  if (s.bundle.opening && s.revealedApplied === 0) s.revealedApplied = 1;
  if (reveal && s.revealedApplied === 0 && s.verifierState === "done") {
    const opening = await openingOf(deps, reveal);
    if (!opening) {
      s.problem = "revealed event stored but the revealed view is empty";
      return s;
    }
    s.bundle = { ...s.bundle, opening };
    s.revealedApplied = 1;
    verify = true;
  }

  if (verify) {
    writeFileSync(file, JSON.stringify(s.bundle));
    const r = await runTool(tools.verify, ["check", file], tools.timeoutMs);
    const summary = r.timedOut ? null : parseSummary(r.stdout);
    if (summary) {
      Object.assign(s, { verifier: summary, verifierState: "done", verifierCommit: deps.verifierCommit ?? null });
      s.replay = s.bundle.opening ? (replayResult(r.stdout) ?? "skip") : "sealed";
    } else {
      s.problem = describeRun("foundling-verify", r, tools.timeoutMs);
    }
  }

  if (s.obsState !== "done") await recheck(deps, s, file);
  return s;
}

async function recheck(deps: ProofDeps, s: WorkState, file: string): Promise<void> {
  if (deps.obsSource === "rehearsal") {
    Object.assign(s, { obsRecheck: SKIPPED, obsState: "done" });
    return;
  }
  writeFileSync(file, JSON.stringify(s.bundle));
  const r = await runTool(deps.tools.python, [deps.tools.recheckObs, file], deps.tools.timeoutMs);
  const summary = r.timedOut ? null : parseSummary(r.stdout);
  if (summary && (r.code === 0 || r.code === RECHECK_FAILED)) {
    Object.assign(s, { obsRecheck: summary, obsState: "done" });
    return;
  }
  s.problem ??= r.code === SOURCE_DOWN ? "recheck_obs.py: a source could not be read (exit 2)" : describeRun("recheck_obs.py", r, deps.tools.timeoutMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Separate from the index loop and its lock-holding round, so a slow proof never delays the heartbeat. */
export async function runProofLoop(deps: Omit<ProofDeps, "now"> & { log: (m: string, f?: Record<string, unknown>) => void }, idleMs = 15_000): Promise<never> {
  for (;;) {
    let worked = false;
    try {
      worked = await processOne({ ...deps, now: () => new Date() });
    } catch (e) {
      deps.log("proof round failed", { vaultId: deps.vaultId, error: describeError(e) });
    }
    if (!worked) await sleep(idleMs);
  }
}
