import { bigint, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Token amounts are numeric(78,0): any U128 fits, and they travel as decimal strings. */
const amount = (name: string) => numeric(name, { precision: 78, scale: 0 });
const height = (name: string) => bigint(name, { mode: "bigint" });

export const syncState = pgTable("sync_state", {
  vaultId: text("vault_id").primaryKey(),
  position: height("position").notNull(),
  tip: height("tip"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  lastError: text("last_error"),
});

/** Append-only. The key keeps one row per log line however many times a window is re-read. */
export const events = pgTable(
  "events",
  {
    vaultId: text("vault_id").notNull(),
    receiptId: text("receipt_id").notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    blockHeight: height("block_height").notNull(),
    receiptIndex: integer("receipt_index").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    name: text("name").notNull(),
    nonce: height("nonce"),
    account: text("account"),
    data: jsonb("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.receiptId, t.logIndex] }), index("events_order").on(t.vaultId, t.blockHeight, t.receiptIndex, t.logIndex), index("events_nonce").on(t.vaultId, t.nonce)],
);

/** Derived from events and rebuilt for every nonce an index round touches. */
export const cycles = pgTable(
  "cycles",
  {
    vaultId: text("vault_id").notNull(),
    nonce: height("nonce").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    closing: text("closing"),
    triggerTx: text("trigger_tx"),
    decisionTx: text("decision_tx"),
    amountIn: amount("amount_in"),
    amountOut: amount("amount_out"),
    lastBlock: height("last_block").notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.nonce] })],
);

/** Raw values only; the share price is computed when read. */
export const navPoints = pgTable(
  "nav_points",
  {
    vaultId: text("vault_id").notNull(),
    nonce: height("nonce").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    blockHeight: height("block_height").notNull(),
    bookUsdc: amount("book_usdc").notNull(),
    bookWnear: amount("book_wnear").notNull(),
    totalShares: amount("total_shares").notNull(),
    oracleNear: amount("oracle_near"),
    oracleUsdc: amount("oracle_usdc"),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.nonce] })],
);

/**
 * The proof bundle is the one thing the chain cannot give back, so it is kept whole: `bundle` is its JSON
 * text. Not jsonb, because Intel collateral ends its PCK certificate chain with a NUL (\u0000), which jsonb
 * refuses.
 */
export const proofs = pgTable(
  "proofs",
  {
    vaultId: text("vault_id").notNull(),
    nonce: height("nonce").notNull(),
    bundle: text("bundle"),
    approvedMeasurements: jsonb("approved_measurements"),
    verifier: jsonb("verifier"),
    obsRecheck: jsonb("obs_recheck"),
    replay: text("replay").notNull().default("sealed"),
    verifierState: text("verifier_state").notNull().default("queued"),
    obsState: text("obs_state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    revealedApplied: integer("revealed_applied").notNull().default(0),
    verifierCommit: text("verifier_commit"),
    lastError: text("last_error"),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.nonce] }), index("proofs_due").on(t.nextAttemptAt)],
);
