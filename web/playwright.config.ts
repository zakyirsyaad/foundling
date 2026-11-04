import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const MOCK = "http://localhost:3199";

/** Test build: testnet, mock RPC/API/1Click, no cache, the m12 sample on. */
const testEnv = {
  NEXT_PUBLIC_NETWORK: "testnet",
  NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet",
  NEXT_PUBLIC_RPC_URLS: `${MOCK}/rpc`,
  NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet",
  NEXT_PUBLIC_WNEAR_ID: "wrap.testnet",
  NEXT_PUBLIC_TEST_BUILD: "1",
  NEXT_PUBLIC_SAMPLE: "m12",
  FOUNDLING_CACHE_SECONDS: "0",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx tests/mock-server/server.ts",
      url: `${MOCK}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npx next build && npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}`,
      env: testEnv,
      // Always rebuild: a reused server may carry an older build or other env.
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
