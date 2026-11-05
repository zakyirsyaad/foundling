/** Worker entry point: one index loop per vault, guarded by an advisory lock. */
import { db as connect } from "@foundling/db";
import { loadConfig } from "./config";
import { createFastnear } from "./fastnear";
import { type Log, runIndexLoop, withVaultLock } from "./loop";
import { createArchivalRpc } from "./rpc";

const log: Log = (message, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...fields }));

const config = loadConfig();
const { db } = connect(config.databaseUrl);
const deps = {
  db,
  fastnear: createFastnear(config.fastnearUrl, fetch, config.fastnearApiKey),
  rpc: createArchivalRpc(config.rpcUrls),
  vaultId: config.vaultId,
  log,
};

log("worker starting", { vaultId: config.vaultId, chain: config.chain });
const outcome = await withVaultLock(db, config.vaultId, () => runIndexLoop(deps));
if (outcome === "locked") {
  log("another worker holds this vault; exiting", { vaultId: config.vaultId });
  process.exit(1);
}
