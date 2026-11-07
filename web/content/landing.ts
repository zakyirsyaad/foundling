import type { WebClaimId } from "@/lib/claims";

export const HERO = {
  title: "A vault born without keys.",
  /** Until the born-without-keys claim passes, the headline does not state it as done. */
  titleUnchecked: "A vault meant to be born without keys.",
  lead: "A USDC vault on NEAR. A sealed strategy trades it, the contract enforces the limits, and you can leave without us.",
} as const;

export const BUILT_ON_FIXED = ["NEAR", "OutLayer", "Rhea"] as const;
export const BUILT_ON_NOTE = "Names only. No endorsement is implied.";

export const HOW_IT_WORKS = [
  { id: "decide", title: "Decide", body: "A strategy WASM in an OutLayer enclave decides with encrypted parameters.", leaves: "Leaves: one signed decision." },
  { id: "check", title: "Check", body: "The vault contract checks every limit before any token moves: caps, cooldown, price age and exposure.", leaves: "Leaves: an accepted or rejected event on chain." },
  { id: "trade", title: "Trade", body: "The vault swaps USDC and wNEAR in Rhea pool 4512, and only there.", leaves: "Leaves: the swap transactions." },
  { id: "verify", title: "Verify", body: "Now you can check the attestation, the inputs and the limits. After reveal, you can replay the rules over the recorded inputs.", leaves: "Leaves: a proof bundle per cycle." },
] as const;

export interface Guarantee {
  id: Extract<WebClaimId, "born-without-keys" | `g${number}-${string}`>;
  tag: string;
  title: string;
  limit: string;
  /** The two guarantees a depositor leans on most take half a row; the rest take a third. */
  wide: boolean;
}

/** Card order follows the design canvas: keys and exit first, then G2, G1 and G4. */
export const GUARANTEES: readonly Guarantee[] = [
  { id: "born-without-keys", tag: "Keys", title: "Born without keys", wide: true, limit: "The governor still holds roles on the contract. It cannot move funds, but it can unfreeze and rotate the guardian." },
  { id: "g3-exit", tag: "G3 · Exit", title: "A way out", wide: true, limit: "Leaving still depends on the USDC and wNEAR contracts." },
  { id: "g2-bounded-loss", tag: "G2 · Limits", title: "Bounded per trade", wide: false, limit: "Losses add up across cycles. Only the book value bounds the total." },
  { id: "g1-confidentiality", tag: "G1 · Secrecy", title: "Sealed parameters", wide: false, limit: "Trades are public, so the rules leak a little with every cycle." },
  { id: "g4-traceability", tag: "G4 · Trace", title: "Traceable", wide: false, limit: "A proof shown here is a claim. The command is the answer." },
];

/** Section heads: eyebrow, title, lead and the short note on the right, as on the design canvas. */
export const HEADS = {
  how: { eyebrow: "How it works", title: "One cycle, four steps.", lead: "Every step leaves something on chain that you can read.", aside: "The mono line under each step is the record it leaves behind." },
  demo: { eyebrow: "Demo", title: "One cycle, start to finish." },
  guarantees: { eyebrow: "Guarantees", title: "What holds, and where it stops.", lead: "Each guarantee names where it stops. Nothing here goes beyond what the contract and the record can show." },
  notClaimed: { eyebrow: "What we don't claim", title: "The limits, in writing.", lead: "A hackathon build that will hold real money should say what it is not." },
} as const;

export const CLOSING = {
  title: "Check it yourself.",
  lead: "Python 3 and the repo are all you need, no keys and no install.",
  commands: ["git clone https://github.com/zakyirsyaad/foundling", "cd foundling && python3 verify.py"],
  note: "The offline checks run on a synthetic fixture. They test the checker, not a live vault.",
} as const;

export const GITHUB_URL = "https://github.com/zakyirsyaad/foundling";
