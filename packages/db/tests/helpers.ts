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
