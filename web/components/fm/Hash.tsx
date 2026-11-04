import { CopyButton } from "./CopyButton";

const HEAD = 6;
const TAIL = 4;

export function truncateMiddle(value: string): string {
  return value.length <= HEAD + TAIL + 1 ? value : `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`;
}

/** A hash or account id in mono, cut in the middle, with a copy button for the full value. */
export function Hash({ value, label }: { value: string; label: string }) {
  return (
    <span className="fm-hash">
      <span className="mono" title={value}>
        {truncateMiddle(value)}
      </span>
      <CopyButton text={value} label={`Copy ${label}`} />
    </span>
  );
}
