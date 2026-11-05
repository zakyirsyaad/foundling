/**
 * Applies migrations and role grants as the database owner, then gives the reader and writer roles the
 * passwords in their own connection URLs, so the VPS .env holds each password once.
 */
import { applyRolePasswords, migrate } from "./migrate";

const passwordOf = (url: string | undefined) => (url ? decodeURIComponent(new URL(url).password) || undefined : undefined);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
await migrate(url);
await applyRolePasswords(url, { reader: passwordOf(process.env.DATABASE_URL_READER), writer: passwordOf(process.env.DATABASE_URL_WRITER) });
console.log("migrations and roles applied");
