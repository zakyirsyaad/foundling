import { loadConfig } from "@/config/deployment";

const mainnetEnv = {
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_VAULT_ID: "foundling-vault.near",
  NEXT_PUBLIC_RPC_URLS: "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org",
};
const testnetEnv = {
  NEXT_PUBLIC_NETWORK: "testnet",
  NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet",
  NEXT_PUBLIC_RPC_URLS: "https://rpc.testnet.fastnear.com",
  NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet",
  NEXT_PUBLIC_WNEAR_ID: "wnear.foundling.testnet",
};

test("testnet never has 1Click", () => {
  expect(loadConfig(testnetEnv).oneClick).toBeNull();
});
test("mainnet refuses a USDC override", () => {
  expect(() => loadConfig({ ...mainnetEnv, NEXT_PUBLIC_USDC_ID: "evil.near" })).toThrow(/USDC/);
});
test("testnet requires the mock token ids", () => {
  expect(() => loadConfig({ ...testnetEnv, NEXT_PUBLIC_USDC_ID: undefined })).toThrow();
});
test("rejects an empty RPC list and a bad vault id", () => {
  expect(() => loadConfig({ ...mainnetEnv, NEXT_PUBLIC_RPC_URLS: "" })).toThrow();
  expect(() => loadConfig({ ...mainnetEnv, NEXT_PUBLIC_VAULT_ID: "Bad..id" })).toThrow();
});
test("cache windows follow the spec", () => {
  const c = loadConfig(mainnetEnv);
  expect(c.landingCacheSeconds).toBeGreaterThanOrEqual(30);
  expect(c.landingCacheSeconds).toBeLessThanOrEqual(60);
  expect(c.appCacheSeconds).toBeLessThanOrEqual(20);
});
test("only a test build may set cache windows to zero", () => {
  expect(loadConfig({ ...mainnetEnv, NEXT_PUBLIC_TEST_BUILD: "1", FOUNDLING_CACHE_SECONDS: "0" }).landingCacheSeconds).toBe(0);
  expect(() => loadConfig({ ...mainnetEnv, FOUNDLING_CACHE_SECONDS: "0" })).toThrow();
});
test("mainnet pins the tokens and the origin chains, all off until SP4", () => {
  const c = loadConfig(mainnetEnv);
  expect(c.usdc).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  expect(c.usdcE).toBe("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near");
  expect(c.wnear).toBe("wrap.near");
  expect(c.oneClick?.baseUrl).toBe("https://1click.chaindefuser.com");
  expect(c.oneClick?.chains.map((ch) => [ch.id, ch.marginMs, ch.deadlineMs, ch.enabled])).toEqual([
    ["base", 120000, 1200000, false],
    ["arb", 120000, 1200000, false],
    ["eth", 300000, 2400000, false],
  ]);
});
test("RPC and API must be https outside a test build", () => {
  expect(() => loadConfig({ ...mainnetEnv, NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc" })).toThrow();
  expect(loadConfig({ ...mainnetEnv, NEXT_PUBLIC_TEST_BUILD: "1", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc" }).rpcUrls).toEqual(["http://localhost:3199/rpc"]);
  expect(loadConfig(mainnetEnv).apiOrigin).toBeNull();
});
test("the m12 sample is opt-in", () => {
  expect(loadConfig(mainnetEnv).sample).toBeNull();
  expect(loadConfig({ ...testnetEnv, NEXT_PUBLIC_SAMPLE: "m12" }).sample).toBe("m12");
});
test("a test build may point 1Click at the mock server", () => {
  const c = loadConfig({ ...mainnetEnv, NEXT_PUBLIC_TEST_BUILD: "1", NEXT_PUBLIC_ONECLICK_URL: "http://localhost:3199/1click" });
  expect(c.oneClick?.baseUrl).toBe("http://localhost:3199/1click");
  expect(loadConfig({ ...mainnetEnv, NEXT_PUBLIC_ONECLICK_URL: "http://localhost:3199/1click" }).oneClick?.baseUrl).toBe("https://1click.chaindefuser.com");
});
test("a test build may use the mock quote key and turn chains on; a real build may not", () => {
  const t = loadConfig({ ...mainnetEnv, NEXT_PUBLIC_TEST_BUILD: "1", NEXT_PUBLIC_ONECLICK_KEY: "ed25519:test", NEXT_PUBLIC_ONECLICK_CHAINS: "base,eth" });
  expect(t.oneClick?.quotePublicKey).toBe("ed25519:test");
  expect(t.oneClick?.chains.map((c) => [c.id, c.enabled])).toEqual([["base", true], ["arb", false], ["eth", true]]);
  const real = loadConfig({ ...mainnetEnv, NEXT_PUBLIC_ONECLICK_KEY: "ed25519:test", NEXT_PUBLIC_ONECLICK_CHAINS: "base" });
  expect(real.oneClick?.quotePublicKey).toBe("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  expect(real.oneClick?.chains.every((c) => !c.enabled)).toBe(true);
});
