/** Rebuilds `cycles` (and queues missing proofs) from `events` for ACTIVE_VAULT_ID. See docs/RUNBOOK.md. */
import { db as connect } from "@foundling/db";
import { loadConfig } from "./config";
import { rederiveAll } from "./loop";

const config = loadConfig();
const { db, pool } = connect(config.databaseUrl, 1);
try {
  const n = await rederiveAll(db, config.vaultId);
  console.log(`${config.vaultId}: ${n} cycles rebuilt from events`);
} finally {
  await pool.end();
}
