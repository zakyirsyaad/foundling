import { loadConfig } from "../src/config";

const base = { DATABASE_URL_READER: "postgres://r@db/foundling", ACTIVE_VAULT_ID: "vault.fdl-m12-0d1276.testnet", WEB_ORIGIN: "https://foundling.xyz" };

test("reads the reader database, vault, origin and proxy network", () => {
  expect(loadConfig({ ...base, TRUST_PROXY_FROM: "172.18.0.0/16, 10.0.0.5", PORT: "9000" })).toEqual({
    databaseUrl: base.DATABASE_URL_READER, vaultId: base.ACTIVE_VAULT_ID, webOrigin: base.WEB_ORIGIN,
    trustProxyFrom: ["172.18.0.0/16", "10.0.0.5"], port: 9000,
  });
});

test("defaults to no trusted proxy and port 8080", () => {
  expect(loadConfig(base)).toMatchObject({ trustProxyFrom: [], port: 8080 });
});

test.each([
  [{ ...base, WEB_ORIGIN: "http://foundling.xyz" }],
  [{ ...base, WEB_ORIGIN: "https://foundling.xyz/" }],
  [{ ...base, WEB_ORIGIN: "*" }],
  [{ ...base, ACTIVE_VAULT_ID: "Bad Id" }],
  [{ ...base, DATABASE_URL_READER: "" }],
  [{ ...base, TRUST_PROXY_FROM: "not-an-ip" }],
  [{ ...base, PORT: "99999" }],
])("refuses a bad env %#", (env) => {
  expect(() => loadConfig(env)).toThrow();
});
