import { loadConfig } from "../src/config";

const base = { ACTIVE_VAULT_ID: "vault.fdl-m12-0d1276.testnet", CHAIN: "testnet", DATABASE_URL_WRITER: "postgres://w@db/foundling" };

test("reads the vault, chain and database from env", () => {
  const c = loadConfig({ ...base, RPC_URLS: "https://rpc.a, https://rpc.b", ARCHIVAL_RPC_URLS: "https://arch" });
  expect(c).toMatchObject({ vaultId: base.ACTIVE_VAULT_ID, chain: "testnet", databaseUrl: base.DATABASE_URL_WRITER, fastnearUrl: "https://tx.test.fastnear.com" });
  expect(c.rpcUrls).toEqual(["https://rpc.a", "https://rpc.b", "https://arch"]);
  expect(c.fastnearApiKey).toBeUndefined();
});

test("mainnet uses the mainnet FastNEAR host and default RPCs", () => {
  const c = loadConfig({ ...base, CHAIN: "mainnet", FASTNEAR_API_KEY: "k" });
  expect(c.fastnearUrl).toBe("https://tx.main.fastnear.com");
  expect(c.fastnearApiKey).toBe("k");
  expect(c.rpcUrls.length).toBeGreaterThan(0);
  expect(c.rpcUrls.every((u) => u.startsWith("https://"))).toBe(true);
});

test.each([
  [{ ...base, ACTIVE_VAULT_ID: "" }],
  [{ ...base, ACTIVE_VAULT_ID: "Not An Account" }],
  [{ ...base, CHAIN: "devnet" }],
  [{ ...base, DATABASE_URL_WRITER: undefined }],
  [{ ...base, RPC_URLS: "http://plain.example" }],
])("refuses a bad env %#", (env) => {
  expect(() => loadConfig(env)).toThrow();
});
