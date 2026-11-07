/** "Returns or alpha." stays one bold line; a longer entry splits into a bold first sentence and the rest. */
export function splitFirstSentence(line: string): { head: string; rest: string | null } {
  const i = line.indexOf(". ");
  return i < 0 ? { head: line, rest: null } : { head: line.slice(0, i + 1), rest: line.slice(i + 2) };
}
