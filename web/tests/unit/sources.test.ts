import { loadConfig } from "@/config/deployment";
import { webClaims } from "@/lib/claims-source";
import { attackRows, loadSample } from "@/lib/proof/sample";

vi.mock("server-only", () => ({}));

const cfg = loadConfig({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc", NEXT_PUBLIC_USDC_ID: "u.testnet", NEXT_PUBLIC_WNEAR_ID: "w.testnet", NEXT_PUBLIC_TEST_BUILD: "1", NEXT_PUBLIC_SAMPLE: "m12" });

test("the m12 sample loads only when it is on", () => {
  expect(loadSample(cfg)?.vaultId).toBe("vault.fdl-m12-0d1276.testnet");
  expect(loadSample({ ...cfg, sample: null })).toBeNull();
});
test("Attack Lab rows come from the registry", () => {
  const rows = attackRows();
  expect(rows.length).toBeGreaterThan(10);
  expect(rows.find((r) => r.name === "over-cap")?.expected).toBe("Rejected(OVER_CAP)");
});
test("a test build reads the fixture claims", () => {
  expect(webClaims(cfg).map((c) => c.id)).toContain("near-intents");
});
test("getSnapshot returns the sample on the landing and unreadable when RPC fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
  process.env.NEXT_PUBLIC_SAMPLE = "m12";
  vi.resetModules();
  const { getSnapshot } = await import("@/lib/chain/source");
  const landing = await getSnapshot("landing");
  expect(landing.ok && landing.source.kind).toBe("sample");
  expect(await getSnapshot("app")).toEqual({ ok: false, reason: "unreadable" });
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_SAMPLE;
});
