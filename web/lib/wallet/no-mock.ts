import type { WalletApi } from "./types";

/** Production stand-in for the mock wallet: next.config.ts aliases "@foundling/wallet-mock" here. */
export function createMockWallet(): WalletApi {
  throw new Error("the mock wallet exists only in a test build");
}
