import fs from "node:fs";

import { z } from "zod";

export const MAX_CLAIMS = 12;
export const WEB_CLAIM_IDS = ["born-without-keys", "g1-confidentiality", "g2-bounded-loss", "g3-exit", "g4-traceability", "near-intents", "near-ai-advisor"] as const;
export type WebClaimId = (typeof WEB_CLAIM_IDS)[number];

/** One row of `claims.json` (SPEC §9.3). */
const claimSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  tracks: z.array(z.string()),
  code_refs: z.array(z.string()),
  test_refs: z.array(z.string()),
  evidence: z.array(z.string()),
  checks: z.array(z.unknown()),
  status: z.enum(["pass", "skip", "fail"]),
  downgrade: z.string().min(1),
});
export type Claim = z.infer<typeof claimSchema>;

export function loadClaims(file: string): Claim[] {
  const claims = z.array(claimSchema).parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (claims.length > MAX_CLAIMS) throw new Error(`claims.json has ${claims.length} claims; at most ${MAX_CLAIMS}`);
  const ids = new Set(claims.map((c) => c.id));
  const missing = WEB_CLAIM_IDS.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`claims.json is missing ${missing.join(", ")}`);
  return claims;
}

/** A claim is only stated once its check passes; until then the website uses its downgrade text. */
export function claimText(claims: Claim[], id: WebClaimId): { text: string; downgraded: boolean } {
  const claim = claims.find((c) => c.id === id);
  if (!claim) throw new Error(`no claim ${id}`);
  return claim.status === "pass" ? { text: claim.claim, downgraded: false } : { text: claim.downgrade, downgraded: true };
}
