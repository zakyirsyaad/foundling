/** API entry point. Connects as foundling_reader; the role's own statement_timeout is 2 s, and the pool sets the same. */
import { serve } from "@hono/node-server";
import { db as connect } from "@foundling/db";
import { createApp } from "./app";
import { loadConfig } from "./config";

const STATEMENT_TIMEOUT_MS = 2000;
const POOL_SIZE = 8;

const config = loadConfig();
const { db } = connect(config.databaseUrl, POOL_SIZE, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
const app = createApp({ db, vaultId: config.vaultId, webOrigin: config.webOrigin, trustProxyFrom: config.trustProxyFrom });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), message: "api listening", port: info.port, vaultId: config.vaultId }));
});
