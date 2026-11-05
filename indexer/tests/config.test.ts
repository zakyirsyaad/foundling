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

test("proof settings: obs source, verifier commit, tools and archival RPCs for fetch_proof", () => {
  const c = loadConfig({ ...base, OBS_SOURCE: "rehearsal", VERIFIER_COMMIT: "0123abc0123abc0123abc0123abc0123abc01234", ARCHIVAL_RPC_URLS: "https://arch", TOOLS_DIR: "/app/tools", VERIFY_BIN: "/usr/local/bin/foundling-verify" });
  expect(c.proofs).toEqual({
    obsSource: "rehearsal", verifierCommit: "0123abc0123abc0123abc0123abc0123abc01234",
    tools: { python: "python3", fetchProof: "/app/tools/fetch_proof.py", recheckObs: "/app/tools/recheck_obs.py", verify: "/usr/local/bin/foundling-verify", rpcUrls: ["https://arch"], timeoutMs: 120_000 },
  });
});

test("obs source defaults to live on mainnet and is required to be a known value", () => {
  expect(loadConfig({ ...base, CHAIN: "mainnet" }).proofs.obsSource).toBe("live");
  expect(() => loadConfig({ ...base, OBS_SOURCE: "maybe" })).toThrow();
  expect(() => loadConfig({ ...base, VERIFIER_COMMIT: "not a sha" })).toThrow();
});

test("compose passes unset optional values as empty strings; they count as unset", () => {
  const c = loadConfig({ ...base, RPC_URLS: "", ARCHIVAL_RPC_URLS: "", FASTNEAR_API_KEY: "", OBS_SOURCE: "", VERIFIER_COMMIT: "", TOOLS_DIR: "" });
  expect(c.fastnearApiKey).toBeUndefined();
  expect(c.proofs.obsSource).toBe("live");
  expect(c.proofs.verifierCommit).toBeUndefined();
});

test("VERIFIER_COMMIT must be a full 40-character sha, as BuildKit git contexts need", () => {
  expect(() => loadConfig({ ...base, VERIFIER_COMMIT: "26ac6d0" })).toThrow();
  expect(loadConfig({ ...base, VERIFIER_COMMIT: "a".repeat(40) }).proofs.verifierCommit).toBe("a".repeat(40));
});
