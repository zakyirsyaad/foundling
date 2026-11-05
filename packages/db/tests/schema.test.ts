import { migrate } from "../src/migrate";
import { asRole, lockTestDb, resetDb, sql } from "./helpers";

const url = process.env.DATABASE_URL!;

let lock: Awaited<ReturnType<typeof lockTestDb>>;
afterAll(() => lock.release());
beforeAll(async () => {
  lock = await lockTestDb(url);
  await resetDb(url);
  await migrate(url);
});

const insertEvent =
  "insert into events (vault_id, receipt_id, log_index, tx_hash, block_height, receipt_index, block_time, name, nonce, account, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)";
const event = (vault = "vault.testnet", receipt = "R1", log = 0) => [vault, receipt, log, "TX1", 100, 0, new Date(0), "minted", null, null, {}];

test("an event key can be stored once only", async () => {
  await sql(url, insertEvent, event());
  await expect(sql(url, insertEvent, event())).rejects.toThrow(/duplicate key/);
  await sql(url, insertEvent, event("vault.testnet", "R1", 1));
});

test("numeric(78,0) keeps a U128 exactly", async () => {
  const max = (2n ** 128n - 1n).toString();
  await sql(url, "insert into nav_points (vault_id, nonce, at, block_height, book_usdc, book_wnear, total_shares) values ('v', 1, now(), 1, $1, 0, $1)", [max]);
  const rows = await sql<{ book_usdc: string }>(url, "select book_usdc from nav_points where vault_id = 'v'");
  expect(rows[0]!.book_usdc).toBe(max);
});

test("the reader role can read but not write, and long queries time out", async () => {
  await expect(asRole(url, "foundling_reader", "insert into sync_state (vault_id, position) values ('x', 1)")).rejects.toThrow(/permission denied/);
  expect(await asRole(url, "foundling_reader", "select count(*) from events")).toHaveLength(1);
  // Role settings apply at login (production), not to SET ROLE, so check the setting itself.
  const cfg = await sql<{ rolconfig: string[] }>(url, "select rolconfig from pg_roles where rolname = 'foundling_reader'");
  expect(cfg[0]!.rolconfig).toContain("statement_timeout=2s");
});

test("the writer role can write events but not change the schema", async () => {
  await asRole(url, "foundling_writer", insertEvent, event("w.testnet"));
  await expect(asRole(url, "foundling_writer", "drop table events")).rejects.toThrow(/must be owner|permission denied/);
});

test("migrate can run twice", async () => {
  await expect(migrate(url)).resolves.toBeUndefined();
});

test("role passwords turn the roles into logins; without them the roles stay NOLOGIN", async () => {
  const { applyRolePasswords } = await import("../src/migrate");
  await applyRolePasswords(url, {});
  const before = await sql<{ rolname: string; rolcanlogin: boolean }>(url, "select rolname, rolcanlogin from pg_roles where rolname like 'foundling_%' order by rolname");
  expect(before.map((r) => r.rolcanlogin)).toEqual([false, false]);
  await applyRolePasswords(url, { reader: "r-pass'quote", writer: "w-pass" });
  const after = await sql<{ rolname: string; rolcanlogin: boolean }>(url, "select rolname, rolcanlogin from pg_roles where rolname like 'foundling_%' order by rolname");
  expect(after).toEqual([{ rolname: "foundling_reader", rolcanlogin: true }, { rolname: "foundling_writer", rolcanlogin: true }]);
  await sql(url, "alter role foundling_reader nologin; alter role foundling_writer nologin;");
});
