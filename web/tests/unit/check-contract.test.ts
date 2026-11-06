import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkContract } from "@/scripts/check-contract";

const src = path.resolve(__dirname, "../../../contracts/vault/src");

function drifted(edit: (file: string, text: string) => string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-src-"));
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".rs"))) {
    fs.writeFileSync(path.join(dir, f), edit(f, fs.readFileSync(path.join(src, f), "utf8")));
  }
  return dir;
}

test("the call table and events match the vault source in this repo", () => {
  expect(checkContract(src)).toEqual({ ok: true, problems: [] });
});
test("a changed advance minimum is caught", () => {
  const dir = drifted((f, t) => (f === "recovery.rs" ? t.replace("MIN_ADVANCE_GAS: Gas = Gas::from_tgas(110)", "MIN_ADVANCE_GAS: Gas = Gas::from_tgas(120)") : t));
  const r = checkContract(dir);
  expect(r.ok).toBe(false);
  expect(r.problems.join("\n")).toMatch(/advance.*120.*110/);
});
test("a changed transfer gas is caught for redeem and the single-transfer calls", () => {
  const dir = drifted((f, t) => (f === "redeem.rs" ? t.replace("FT_TRANSFER_GAS: Gas = Gas::from_tgas(30)", "FT_TRANSFER_GAS: Gas = Gas::from_tgas(35)") : t));
  const r = checkContract(dir);
  expect(r.problems.join("\n")).toMatch(/redeem.*105/);
  expect(r.problems.join("\n")).toMatch(/cancel_deposit.*60/);
});
test("a new event name is caught", () => {
  const dir = drifted((f, t) => (f === "deposit.rs" ? `${t}\nfn x() { emit(\n "bucket_swept", "{}"); }\n` : t));
  const r = checkContract(dir);
  expect(r.problems.join("\n")).toMatch(/bucket_swept/);
});
test("a missing constant is a problem, not a pass", () => {
  const dir = drifted((f, t) => (f === "recovery.rs" ? t.replace(/const MIN_ADVANCE_GAS[^\n]*\n/, "") : t));
  expect(checkContract(dir).problems.join("\n")).toMatch(/MIN_ADVANCE_GAS/);
});
