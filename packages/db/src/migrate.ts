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
