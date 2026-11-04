import { defineConfig, devices } from "@playwright/test";

import { TEST_ONECLICK_KEY } from "./tests/mock-server/oneclick";

const PORT = 3100;
const MAINNET_PORT = 3101;
export const MOCK = "http://localhost:3199";

/** Test build: testnet, mock RPC/API/1Click, no cache, the m12 sample on. */
const testEnv = {
  NEXT_PUBLIC_NETWORK: "testnet",
  NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet",
  NEXT_PUBLIC_RPC_URLS: `${MOCK}/rpc`,
  NEXT_PUBLIC_API_ORIGIN: `${MOCK}/api`,
  NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet",
  NEXT_PUBLIC_WNEAR_ID: "wrap.testnet",
  NEXT_PUBLIC_TEST_BUILD: "1",
  NEXT_PUBLIC_SAMPLE: "m12",
  FOUNDLING_CACHE_SECONDS: "0",
};

/** Mainnet test build: the only network where the 1Click card renders. */
const mainnetEnv = {
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_VAULT_ID: "foundling-vault.near",
  NEXT_PUBLIC_RPC_URLS: `${MOCK}/rpc`,
  NEXT_PUBLIC_API_ORIGIN: `${MOCK}/api`,
  NEXT_PUBLIC_TEST_BUILD: "1",
  NEXT_PUBLIC_ONECLICK_URL: `${MOCK}/1click`,
  NEXT_PUBLIC_ONECLICK_KEY: TEST_ONECLICK_KEY,
  NEXT_PUBLIC_ONECLICK_CHAINS: "base,arb,eth",
  FOUNDLING_CACHE_SECONDS: "0",
  FOUNDLING_DIST_DIR: ".next-mainnet",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /crosschain\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "mainnet", testMatch: /crosschain\.spec\.ts/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${MAINNET_PORT}` } },
  ],
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
    {
      command: `npx next build && npx next start -p ${MAINNET_PORT}`,
      url: `http://localhost:${MAINNET_PORT}`,
      env: mainnetEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
