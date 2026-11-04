import fs from "node:fs";
import path from "node:path";

import { findForbidden } from "@/content/forbidden";

test("finds the words the spec does not claim", () => {
  expect(findForbidden("Earn 12% APY")).toEqual(["APY"]);
  expect(findForbidden("high yield, great returns")).toEqual(["yield", "returns"]);
  expect(findForbidden("A trustless, non-custodial, fully decentralised vault")).toEqual(["trustless", "non-custodial", "fully decentralised"]);
  expect(findForbidden("proven alpha, annualized")).toEqual(["proven", "alpha", "annualized"]);
  expect(findForbidden("anti-MEV and profitable")).toEqual(["anti-MEV", "profitable"]);
});
test("ordinary words around them are fine", () => {
  expect(findForbidden("Deposits over the cap are returned in full")).toEqual([]);
  expect(findForbidden("Refunded to your address. Read the proof.")).toEqual([]);
  expect(findForbidden("Share price since start")).toEqual([]);
});
test("claims and content files pass, except the not-claimed list", () => {
  const root = path.resolve(__dirname, "../..");
  const texts: string[] = [];
  const claims = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/claims.json"), "utf8")) as { claim: string; downgrade: string }[];
  for (const c of claims) texts.push(c.claim, c.downgrade);
  for (const f of fs.readdirSync(path.join(root, "content"))) {
    if (f === "not-claimed.ts" || f === "forbidden.ts") continue;
    texts.push(fs.readFileSync(path.join(root, "content", f), "utf8"));
  }
  expect(texts.flatMap(findForbidden)).toEqual([]);
});
