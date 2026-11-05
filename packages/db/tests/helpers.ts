import pg from "pg";

/** Drops and recreates the public schema of the test database. Never pointed at anything else. */
export async function resetDb(url: string): Promise<void> {
  if (!/foundling_test/.test(url)) throw new Error(`refusing to reset ${url}`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
}

export async function sql<T = Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Runs `text` as `role` inside one session. */
export async function asRole<T = Record<string, unknown>>(url: string, role: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`set role ${role}`);
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Any number fixed for the repo: every test file that resets the database takes this lock first. */
const TEST_DB_LOCK = 7_310_001;

/**
 * Holds the test database for one test file. Vitest 5.0.5 runs files in parallel even with
 * `fileParallelism: false`, so the lock lives in Postgres instead of in the runner.
 */
export async function lockTestDb(url: string): Promise<{ release: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("select pg_advisory_lock($1)", [TEST_DB_LOCK]);
  return { release: () => c.end() };
}
