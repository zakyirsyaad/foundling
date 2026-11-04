/** Words the website never uses outside the one "What we don't claim" block (SPEC §1, WEBSITE §6). */
export const FORBIDDEN: readonly RegExp[] = [
  /\bAPY\b/gi,
  /\bAPR\b/gi,
  /\byields?\b/gi,
  /\breturns?\b/gi,
  /\balpha\b/gi,
  /\bprofit\w*/gi,
  /\bannuali[sz]ed\b/gi,
  /\bproven\b/gi,
  /\bprovably\b/gi,
  /\btrustless\b/gi,
  /\bnon-custodial\b/gi,
  /\bfully decentrali[sz]ed\b/gi,
  /\banti-MEV\b/gi,
];

/** Every forbidden word in `text`, in order of appearance. */
export function findForbidden(text: string): string[] {
  const hits: { at: number; word: string }[] = [];
  for (const re of FORBIDDEN) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index ?? 0, word: m[0] });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.word);
}
