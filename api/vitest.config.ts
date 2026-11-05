import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The contract test imports the website's schemas, which use the web "@/" alias.
const web = fileURLToPath(new URL("../web", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": web } },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests share one Postgres database; run files one at a time.
    fileParallelism: false,
    // Files wait on each other through lockTestDb (packages/db/tests/helpers.ts).
    hookTimeout: 120_000,
    env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgres://localhost:55432/foundling_test" },
    coverage: { provider: "v8", include: ["src/**"], exclude: ["src/main.ts"], thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 } },
  },
});
