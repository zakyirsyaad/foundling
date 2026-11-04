import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
await migrate(url);
console.log("migrations and roles applied");
