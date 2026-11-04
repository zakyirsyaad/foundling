import { loadConfig } from "@/config/deployment";
import { buildCsp } from "@/lib/security/csp";

const mainnet = loadConfig({ NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_VAULT_ID: "foundling-vault.near", NEXT_PUBLIC_RPC_URLS: "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org", NEXT_PUBLIC_API_ORIGIN: "https://api.foundling.xyz" });

test("CSP has no wildcard and names the RPC, API and 1Click hosts", () => {
  const csp = buildCsp(mainnet, "n0nce", false);
  expect(csp).not.toMatch(/(\s|^)\*(\s|;|$)/);
  expect(csp).toContain("https://1click.chaindefuser.com");
  expect(csp).toContain("https://rpc.mainnet.fastnear.com");
  expect(csp).toContain("https://api.foundling.xyz");
  expect(csp).toContain("'nonce-n0nce'");
  expect(csp).toContain("script-src 'self' 'nonce-n0nce' 'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain("unsafe-eval");
});
test("the wallet manifest and executor hosts are allowed to load", () => {
  const csp = buildCsp(mainnet, "n", false);
  expect(csp).toContain("https://raw.githubusercontent.com");
  expect(csp).toContain("https://cdn.jsdelivr.net");
});
test("development adds unsafe-eval; production upgrades insecure requests", () => {
  expect(buildCsp(mainnet, "n", true)).toContain("'unsafe-eval'");
  expect(buildCsp(mainnet, "n", false)).toContain("upgrade-insecure-requests");
});
test("a test build allows the local mock and does not force https", () => {
  const t = loadConfig({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc", NEXT_PUBLIC_USDC_ID: "u.testnet", NEXT_PUBLIC_WNEAR_ID: "w.testnet", NEXT_PUBLIC_TEST_BUILD: "1" });
  const csp = buildCsp(t, "n", false);
  expect(csp).toContain("http://localhost:3199");
  expect(csp).not.toContain("upgrade-insecure-requests");
});
