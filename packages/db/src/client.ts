import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

/** The pool stays reachable as `$client`, for session-level work such as advisory locks. */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** A pooled Drizzle client. `max` stays small: the VPS runs the API and the worker side by side. */
export function db(url: string, max = 5): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema }), pool };
}

/** True when Postgres at `url` answers `select 1`. */
export async function pingDb(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const r = await client.query("select 1 as ok");
    return r.rows[0]?.ok === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
