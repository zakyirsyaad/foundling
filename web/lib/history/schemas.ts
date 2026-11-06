import { z } from "zod";

import { parseU128 } from "@/lib/format/units";

/** Wire format of api.<domain> (WEBSITE §5): snake_case JSON, amounts as decimal strings. */
export const MAX_ROWS = 100;

const amount = z.string().transform((s) => parseU128(s));
const big = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
/** A NEAR transaction hash (base58). Anything else from the API is refused: it lands in copyable commands. */
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

export const tallySchema = z.object({ pass: z.number().int().nonnegative(), skip: z.number().int().nonnegative(), fail: z.number().int().nonnegative(), state: z.enum(["queued", "running", "done", "failed_to_build"]) });
export type Tally = z.infer<typeof tallySchema>;

export const cycleSchema = z
  .object({
    nonce: big, started_at: z.string(), finished_at: z.string().nullable(),
    events: z.array(z.object({ name: z.string(), code: z.string().optional() })),
    amount_in: amount.nullable(), amount_out: amount.nullable(), tx_hashes: z.array(txHash),
    verifier: tallySchema.nullable(), obs_recheck: tallySchema.nullable(),
  })
  .transform((c) => ({
    nonce: c.nonce, startedAt: c.started_at, finishedAt: c.finished_at,
    events: c.events.map((e) => (e.code === undefined ? { name: e.name } : { name: e.name, code: e.code })),
    amountIn: c.amount_in, amountOut: c.amount_out, txHashes: c.tx_hashes, verifier: c.verifier, obsRecheck: c.obs_recheck,
  }));
export type CycleRow = z.output<typeof cycleSchema>;

export const navSchema = z
  .object({ nonce: big, at: z.string(), book: z.object({ usdc: amount, wnear: amount }), total_shares: amount, oracle: z.object({ near: amount, usdc: amount }).nullable() })
  .transform((n) => ({ nonce: n.nonce, at: n.at, book: n.book, totalShares: n.total_shares, oracle: n.oracle }));
export type NavPoint = z.output<typeof navSchema>;

export const statusSchema = z
  .object({ position: big, heartbeat_at: z.string(), tip_lag: big })
  .transform((s) => ({ position: s.position, heartbeatAt: s.heartbeat_at, tipLag: s.tip_lag }));
export type WorkerStatus = z.output<typeof statusSchema>;

export const proofSchema = z
  .object({
    verifier: tallySchema.nullable(),
    obs_recheck: tallySchema.nullable(),
    replay: z.enum(["sealed", "pass", "fail", "skip"]),
    // Absent from an API older than this field. Anything but a full sha reads as unknown, so one odd
    // value cannot void the tallies beside it.
    verifier_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional().catch(null),
  })
  .transform((p) => ({ verifier: p.verifier, obsRecheck: p.obs_recheck, replay: p.replay, verifierCommit: p.verifier_commit ?? null }));
export type ProofResult = z.output<typeof proofSchema>;

export const envelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: z.string().nullable(),
  meta: z.object({ cursor: z.string().nullable().optional() }).loose().nullable(),
});
