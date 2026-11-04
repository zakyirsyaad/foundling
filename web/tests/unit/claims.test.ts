import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WEB_CLAIM_IDS, claimText, loadClaims } from "@/lib/claims";

const fixture = path.resolve(__dirname, "../fixtures/claims.json");
const raw = JSON.parse(fs.readFileSync(fixture, "utf8"));

function tmp(data: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claims-")), "claims.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

test("a passing claim shows its claim text", () => {
  expect(claimText(loadClaims(fixture), "born-without-keys")).toEqual({ text: raw[0].claim, downgraded: false });
});
test("anything but pass shows the downgrade text", () => {
  expect(claimText(loadClaims(fixture), "near-intents")).toEqual({ text: raw[5].downgrade, downgraded: true });
  const failed = raw.map((c: { id: string }) => (c.id === "g3-exit" ? { ...c, status: "fail" } : c));
  expect(claimText(loadClaims(tmp(failed)), "g3-exit").downgraded).toBe(true);
});
test("more than 12 claims is refused", () => {
  const extra = Array.from({ length: 6 }, (_, i) => ({ ...raw[0], id: `extra-${i}` }));
  expect(() => loadClaims(tmp([...raw, ...extra]))).toThrow(/12/);
});
test("a claim id the website needs must exist", () => {
  expect(() => loadClaims(tmp(raw.filter((c: { id: string }) => c.id !== "near-intents")))).toThrow(/near-intents/);
});
test("a malformed claims file is refused, not ignored", () => {
  expect(() => loadClaims(tmp([{ id: "born-without-keys" }]))).toThrow();
  expect(() => loadClaims("/no/such/claims.json")).toThrow();
});
test("the web ids are the ones the pages use", () => {
  expect(WEB_CLAIM_IDS).toEqual(["born-without-keys", "g1-confidentiality", "g2-bounded-loss", "g3-exit", "g4-traceability", "near-intents", "near-ai-advisor"]);
});
