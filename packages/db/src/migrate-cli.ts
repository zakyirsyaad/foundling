import { applyRolePasswords, migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
await migrate(url);
await applyRolePasswords(url, { reader: process.env.READER_PASSWORD, writer: process.env.WRITER_PASSWORD });
console.log("migrations and roles applied");
