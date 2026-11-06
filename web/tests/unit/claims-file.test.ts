import fs from "node:fs";
import path from "node:path";

import { WEB_CLAIM_IDS, loadClaims } from "@/lib/claims";

// The repo-root claims.json the website and README read (SPEC §9.3). The schema in
// lib/claims.ts only types `checks` as unknown, so this pins what a judge relies on.
const root = path.resolve(__dirname, "../../..");
const file = path.join(root, "claims.json");
const claims = loadClaims(file);

// SPEC §1: the tracks are locked by the project owner.
const TRACKS = new Set(["privacy", "defi", "security", "agents"]);
// SPEC §11: 0a offline, 0b needs Rust, 1 live read-only, 2 writes on testnet, 3 mainnet.
const TIERS = new Set(["0a", "0b", "1", "2", "3"]);

type Check = { tier: string; cmd: string; requires: string[]; network: string; seconds: number; expect: string };

test("every website claim id is in claims.json", () => {
  expect(claims.map((c) => c.id)).toEqual(expect.arrayContaining([...WEB_CLAIM_IDS]));
});

test("every claim names only the project's tracks", () => {
  for (const c of claims) {
    expect(c.tracks.length, c.id).toBeGreaterThan(0);
    for (const track of c.tracks) expect(TRACKS.has(track), `${c.id}: ${track}`).toBe(true);
  }
});

test("every file a claim points at exists", () => {
  for (const c of claims) {
    for (const ref of [...c.code_refs, ...c.test_refs, ...c.evidence]) {
      expect(fs.existsSync(path.join(root, ref)), `${c.id}: ${ref}`).toBe(true);
    }
  }
});

test("every check has the fields SPEC §9.3 names", () => {
  for (const c of claims) {
    for (const check of c.checks as Check[]) {
      expect(TIERS.has(check.tier), `${c.id}: tier ${check.tier}`).toBe(true);
      expect(check.cmd, c.id).toMatch(/\S/);
      expect(Array.isArray(check.requires), c.id).toBe(true);
      expect(check.network, c.id).toMatch(/\S/);
      expect(check.seconds, c.id).toBeGreaterThan(0);
      expect(check.expect, c.id).toMatch(/\S/);
    }
  }
});

test("a check that fetches a proof passes the flag fetch_proof.py requires", () => {
  for (const c of claims) {
    for (const check of c.checks as Check[]) {
      if (check.cmd.includes("tools/fetch_proof.py")) expect(check.cmd, c.id).toContain("--collateral-bin");
    }
  }
});

test("a check that reads the live chain without writing is Tier 1", () => {
  for (const c of claims) {
    for (const check of c.checks as Check[]) {
      if (check.cmd.includes("tools/fetch_proof.py")) expect(check.tier, c.id).toBe("1");
    }
  }
});
