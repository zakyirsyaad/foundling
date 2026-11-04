import { type StatusGroup, toneOf } from "@/lib/status/table";

/** A status chip: dot plus word, coloured only through the Status table. */
export function Status({ group, word }: { group: StatusGroup; word: string }) {
  const tone = toneOf(group, word);
  return (
    <span data-tone={tone} className="fm-status">
      <span aria-hidden="true" className="fm-status-dot" />
      <span>{word}</span>
    </span>
  );
}
