import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@foundling/wallet-mock": `${root}/lib/wallet/mock.ts`, "@": root } },
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    projects: [
      { extends: true, test: { name: "node", environment: "node", include: ["tests/unit/**/*.test.ts"] } },
      { extends: true, test: { name: "dom", environment: "jsdom", include: ["tests/unit/**/*.test.tsx"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["lib/**", "features/**"],
      exclude: ["**/*.d.ts"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
