import path from "node:path";

import { loadConfig } from "@/config/deployment";
import { deserializeSnapshot, serializeSnapshot } from "@/lib/chain/serialize";
import { proofFacts } from "@/lib/proof/facts";
import { proofSource, readLocalProofs } from "@/lib/proof/local";
import { fixtureSnapshot } from "../fixtures/snapshot";

const repoRoot = path.resolve(__dirname, "../../..");
const testnet = loadConfig({
  NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet", NEXT_PUBLIC_RPC_URLS: "https://rpc.testnet.fastnear.com",
  NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet", NEXT_PUBLIC_WNEAR_ID: "wrap.testnet", NEXT_PUBLIC_SAMPLE: "m12",
});

test("the proofs/ files in this repo are synthetic", () => {
  const local = readLocalProofs(repoRoot);
  expect(local.synthetic).toBe(true);
  expect(local.commitment?.commitment).toMatch(/^[0-9a-f]{64}$/);
  expect(local.accessKeys).toBe(0);
});
test("with the m12 sample on, the sample wins over a live read", async () => {
  const live = await fixtureSnapshot();
  const sample = await fixtureSnapshot({ vaultId: "vault.fdl-m12-0d1276.testnet" });
  const src = proofSource(testnet, live, sample);
  expect(src).toMatchObject({ kind: "sample", label: "Testnet rehearsal vault (m12)" });
  expect(proofSource({ ...testnet, sample: null }, live, sample)).toEqual({ kind: "live", snapshot: live });
  expect(proofSource({ ...testnet, sample: null }, null, sample)).toBeNull();
});
test("a rehearsal vault with keys says so next to the key count", async () => {
  const sample = await fixtureSnapshot({}, 1);
  const facts = proofFacts({ kind: "sample", label: "Testnet rehearsal vault (m12)", snapshot: sample }, readLocalProofs(repoRoot), "testnet");
  const keys = facts.find((f) => f.id === "keys")!;
  expect(keys.value).toBe("1 access key");
  expect(keys.note).toBe("This rehearsal vault has keys. The final vault is born without them.");
  expect(facts.map((f) => f.id)).toEqual(["keys", "code", "strategy", "commitment"]);
  expect(facts.find((f) => f.id === "strategy")!.command).toBe("curl -sL 'https://example.org/strategy.wasm' | shasum -a 256");
  expect(facts.find((f) => f.id === "keys")!.command).toBe(`near account list-keys ${sample.vaultId} network-config testnet now`);
});
test("a live vault with no keys has no note", async () => {
  const live = await fixtureSnapshot();
  const keys = proofFacts({ kind: "live", snapshot: live }, readLocalProofs(repoRoot), "mainnet").find((f) => f.id === "keys")!;
  expect(keys.value).toBe("0 access keys");
  expect(keys.note).toBeUndefined();
});
test("a snapshot survives serialization exactly", async () => {
  const s = await fixtureSnapshot();
  expect(deserializeSnapshot(serializeSnapshot(s))).toEqual(s);
});

import { base58ToHex } from "@/lib/proof/facts";

test("base58 decodes with leading zero bytes kept", () => {
  expect(base58ToHex("2NEpo7TZRRrLZSi2U")).toBe("48656c6c6f20576f726c6421");
  expect(base58ToHex("11111111111111111111111111111111")).toBe("00".repeat(32));
  expect(base58ToHex("1112")).toBe("00000001");
  expect(base58ToHex("0OIl")).toBeNull();
});

import fs from "node:fs";
import { unreadableFacts } from "@/lib/proof/facts";
import { attackRows, expectedLine } from "@/lib/proof/sample";

test("an unreadable vault still lists the four facts, each with a command that reads the chain", () => {
  const facts = unreadableFacts("vault.foundling.testnet", "testnet");
  expect(facts.map((f) => f.id)).toEqual(["keys", "code", "strategy", "commitment"]);
  for (const f of facts) expect(f.value).toBe("Not readable right now");
  expect(facts.find((f) => f.id === "keys")!.command).toBe("near account list-keys vault.foundling.testnet network-config testnet now");
  expect(facts.find((f) => f.id === "strategy")!.command).toBe("near contract call-function as-read-only vault.foundling.testnet agent json-args '{}' network-config testnet now");
  expect(facts.find((f) => f.id === "strategy")!.href).toBeUndefined();
});

test("every Attack Lab row reads in English, one line per registry attack", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, "tools", "attack-registry.json"), "utf8")) as { attacks: { name: string }[] };
  const rows = attackRows();
  expect(rows.map((r) => r.name)).toEqual(registry.attacks.map((a) => a.name));
  for (const r of rows) expect(r.expected).not.toMatch(/\b(pada|tanpa|atau|tidak|oleh|tetap|saja|dan|ditolak|kembali)\b/i);
  expect(rows.find((r) => r.name === "drip")!.expected).toBe("Rejected(OVER_EPOCH_CAP) on the decision that crosses the limit");
});

test("an attack without an English line shows its codes, and never a blank cell or a crash", () => {
  expect(expectedLine({ name: "over-cap", codes: [] })).toBe("Rejected(OVER_CAP)");
  expect(expectedLine({ name: "new-attack", codes: ["OVER_CAP", "FROZEN"] })).toBe("OVER_CAP, FROZEN");
  expect(expectedLine({ name: "new-attack", codes: [] })).toBe("See tools/attack-registry.json");
  expect(expectedLine({ name: "new-attack" })).toBe("See tools/attack-registry.json");
});
