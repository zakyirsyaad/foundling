const SENTENCES: readonly [RegExp, string][] = [
  [/NOT_STUCK/, "The vault is not stuck yet, so there is nothing to advance. The status has been read again."],
  [/bucket not resolved/i, "That swap has not finished yet. The claim opens once it does."],
  [/LOW_GAS/, "The transaction did not carry enough gas. Try again; the website adds a margin."],
  [/NOT_ALLOWED/, "This account is not on the vault's allowlist."],
  [/attach exactly the registration fee/i, "The registration needs the exact fee the vault asks for. Nothing was charged."],
  [/already registered/i, "This account is already registered with the vault."],
  [/FROZEN/, "The vault is frozen, so new deposits and trades are paused. Redeem still works."],
  [/HALTED/, "The vault is halted until the governor clears it. Redeem still works."],
  [/COOLDOWN/, "The vault is in its cooldown between cycles."],
  [/NOT_EXPIRED/, "The decision has not expired yet."],
  [/NOT_STALE/, "The cycle is not stale yet."],
];

/** A contract panic in words a person can act on. The raw code is shown next to it. */
export function contractErrorSentence(raw: string): string {
  for (const [re, sentence] of SENTENCES) if (re.test(raw)) return sentence;
  return "The contract rejected this transaction.";
}
