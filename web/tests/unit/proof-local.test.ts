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
test("a sealed vault's commitment command checks the fixture and says so", async () => {
  const live = await fixtureSnapshot();
  const fact = proofFacts({ kind: "live", snapshot: { ...live, revealed: false } }, readLocalProofs(repoRoot), "mainnet").find((f) => f.id === "commitment")!;
  expect(fact.command).toBe("python3 verify.py commitment");
  expect(fact.note).toMatch(/Sealed until reveal/);
});

test("once the vault is revealed the commitment command reads the live vault, not the synthetic fixture", async () => {
  const live = await fixtureSnapshot();
  const fact = proofFacts({ kind: "live", snapshot: { ...live, revealed: true } }, readLocalProofs(repoRoot), "mainnet").find((f) => f.id === "commitment")!;
  expect(fact.command).toBe(`python3 verify.py --live --vault ${live.vaultId} --network mainnet`);
  expect(fact.note).toMatch(/PASS commitment/);
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
import os from "node:os";
import { unreadableFacts } from "@/lib/proof/facts";
import { attackBuilds, attackRows, expectedLine } from "@/lib/proof/sample";

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

test("each committed reproducible proof shows its own result and the vault build it ran on", () => {
  const dir = path.join(repoRoot, "proofs", "attack", "reproducible");
  const committed = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(committed.length).toBeGreaterThan(0);
  const rows = attackRows();
  for (const f of committed) {
    const proof = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { result: string; vault_wasm_sha256: string };
    const row = rows.find((r) => r.name === f.replace(/\.json$/, ""));
    expect(row?.result, f).toBe(proof.result === "PASS" ? "Pass" : "Fail");
    expect(row?.build, f).toBe(proof.vault_wasm_sha256);
  }
  const names = committed.map((f) => f.replace(/\.json$/, ""));
  expect(rows.filter((r) => r.result === "No proof committed").map((r) => r.name).sort()).toEqual(rows.map((r) => r.name).filter((n) => !names.includes(n)).sort());
});

test("a FAIL proof shows Fail, a missing one says no proof is committed, and one bad file only marks its own row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attack-proofs-"));
  try {
    fs.writeFileSync(path.join(dir, "over-cap.json"), JSON.stringify({ attack: "over-cap", result: "PASS", vault_wasm_sha256: "ab".repeat(32) }));
    fs.writeFileSync(path.join(dir, "drip.json"), JSON.stringify({ attack: "drip", result: "FAIL" }));
    fs.writeFileSync(path.join(dir, "replay.json"), "{\"attack\": \"replay\", \"res");
    const rows = attackRows(dir);
    expect(rows).toHaveLength(attackRows().length);
    expect(rows.find((r) => r.name === "over-cap")).toMatchObject({ result: "Pass", build: "ab".repeat(32) });
    expect(rows.find((r) => r.name === "drip")).toMatchObject({ result: "Fail", build: null });
    expect(rows.find((r) => r.name === "replay")).toMatchObject({ result: "Proof unreadable", build: null });
    expect(rows.find((r) => r.name === "bad-route")).toMatchObject({ result: "No proof committed", build: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tested builds are listed once each, and compared with the code the vault reports", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  const row = (build: string | null) => ({ name: "x", expected: "", result: "Pass" as const, build });
  expect(attackBuilds([row(a), row(a), row(null)], a)).toEqual({ builds: [a], matchesLive: true });
  expect(attackBuilds([row(a)], b)).toEqual({ builds: [a], matchesLive: false });
  expect(attackBuilds([row(a), row(b)], a)).toEqual({ builds: [a, b], matchesLive: false });
  expect(attackBuilds([row(a)], null)).toEqual({ builds: [a], matchesLive: null });
  expect(attackBuilds([row(null)], a)).toEqual({ builds: [], matchesLive: null });
});

test("an attack without an English line shows its codes, and never a blank cell or a crash", () => {
  expect(expectedLine({ name: "over-cap", codes: [] })).toBe("Rejected(OVER_CAP)");
  expect(expectedLine({ name: "new-attack", codes: ["OVER_CAP", "FROZEN"] })).toBe("OVER_CAP, FROZEN");
  expect(expectedLine({ name: "new-attack", codes: [] })).toBe("See tools/attack-registry.json");
  expect(expectedLine({ name: "new-attack" })).toBe("See tools/attack-registry.json");
});
