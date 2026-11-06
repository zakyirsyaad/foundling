export const HERO = {
  title: "A vault born without keys.",
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

export const GUARANTEE_LIMITS: Record<string, { title: string; limit: string }> = {
  "born-without-keys": { title: "Born without keys", limit: "The governor still holds roles on the contract. It cannot move funds, but it can unfreeze and rotate the guardian." },
  "g1-confidentiality": { title: "G1 · Sealed parameters", limit: "Trades are public, so the rules leak a little with every cycle." },
  "g2-bounded-loss": { title: "G2 · Bounded per trade", limit: "Losses add up across cycles. Only the book value bounds the total." },
  "g3-exit": { title: "G3 · A way out", limit: "Leaving still depends on the USDC and wNEAR contracts." },
  "g4-traceability": { title: "G4 · Traceable", limit: "A proof shown here is a claim. The command is the answer." },
};

export const CLOSING = {
  title: "Check it yourself.",
  commands: ["git clone https://github.com/zakyirsyaad/foundling", "cd foundling && python3 verify.py"],
  note: "The offline checks run on a synthetic fixture. They test the checker, not a live vault.",
} as const;

export const GITHUB_URL = "https://github.com/zakyirsyaad/foundling";
