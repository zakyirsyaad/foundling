import pg from "pg";

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
