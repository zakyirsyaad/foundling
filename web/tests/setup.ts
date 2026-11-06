import "@testing-library/jest-dom/vitest";

// The runtime config (config/index.ts) reads these; tests run as a testnet test build.
process.env.NEXT_PUBLIC_NETWORK ??= "testnet";
process.env.NEXT_PUBLIC_VAULT_ID ??= "vault.foundling.testnet";
process.env.NEXT_PUBLIC_RPC_URLS ??= "http://localhost:3199/rpc";
process.env.NEXT_PUBLIC_USDC_ID ??= "usdc.foundling.testnet";
process.env.NEXT_PUBLIC_WNEAR_ID ??= "wrap.testnet";
process.env.NEXT_PUBLIC_TEST_BUILD ??= "1";
process.env.FOUNDLING_CACHE_SECONDS ??= "0";

if (typeof window !== "undefined") {
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}
