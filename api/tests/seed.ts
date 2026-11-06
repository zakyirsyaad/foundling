/** Fills the test database with testnet vault m12, indexed by the real indexer from its recorded fixture. */
import { type Db, db as connect, migrate } from "@foundling/db";
import { indexOnce } from "../../indexer/src/loop";
import { fakeRpc, fixture, log } from "../../indexer/tests/support";
import { lockTestDb, resetDb, sql } from "../../packages/db/tests/helpers";

export const url = process.env.DATABASE_URL!;
/** Reads go through the reader role, as in production. */
export const readerUrl = `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c role=foundling_reader")}`;
export const M12 = "vault.fdl-m12-0d1276.testnet";

export async function seedM12(): Promise<void> {
  await resetDb(url);
  await migrate(url);
  const { db, pool } = connect(url, 2);
  try {
    const m12 = fixture("m12");
    await indexOnce({ db: db as Db, fastnear: m12.fastnear, rpc: fakeRpc(), vaultId: M12, log });
  } finally {
    await pool.end();
  }
  await sql(url, `update proofs set verifier = '{"pass":9,"skip":2,"fail":0}', verifier_state = 'done', replay = 'pass',
                  bundle = $1 where nonce = 1`, [JSON.stringify({ chain: "testnet", cycles: [{ collateral: { pck_certificate_chain: "-----END CERTIFICATE-----\n\u0000" } }] })]);
}

export { lockTestDb, sql };
