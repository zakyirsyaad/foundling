import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Applies every migration, then the role grants. Safe to run on every deploy. */
export async function migrate(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await runMigrations(drizzle(pool), { migrationsFolder: path.join(here, "..", "migrations") });
    await pool.query(fs.readFileSync(path.join(here, "roles.sql"), "utf8"));
  } finally {
    await pool.end();
  }
}

/**
 * Gives the roles a password and LOGIN (production, from the VPS .env). The password goes through
 * escapeLiteral: ALTER ROLE takes no bind parameters. Roles without a password are left as they are.
 */
export async function applyRolePasswords(url: string, passwords: { reader?: string; writer?: string }): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const [role, password] of [["foundling_reader", passwords.reader], ["foundling_writer", passwords.writer]] as const) {
      if (password) await client.query(`alter role ${role} login password ${client.escapeLiteral(password)}`);
    }
  } finally {
    await client.end();
  }
}
