import Link from "next/link";

import { Hash } from "@/components/fm/Hash";
import { Status } from "@/components/fm/Status";
import { formatUnits } from "@/lib/format/units";
import type { CycleFilter, CycleRow } from "@/lib/history/client";
import type { PartialCycle } from "@/lib/cycles/fallback";
import { cycleWord } from "@/lib/cycles/outcome";
import { proofWord } from "@/lib/proof/tally";

const FILTERS: { id: CycleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "executed", label: "Executed" },
  { id: "hold", label: "Hold" },
  { id: "other", label: "Other" },
];

/** The API's keyset cursor is base64url (docs/plans/2026-11-05-backend.md); anything else from the URL is dropped. */
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export function cycleCursor(raw: string | undefined): string | undefined {
  return raw && CURSOR.test(raw) ? raw : undefined;
}

function cyclesHref(filter: CycleFilter, cursor?: string): string {
  const q = new URLSearchParams();
  if (filter !== "all") q.set("filter", filter);
  if (cursor) q.set("cursor", cursor);
  const text = q.toString();
  return text ? `/app/cycles?${text}` : "/app/cycles";
}

export function CycleFilterBar({ active }: { active: CycleFilter }) {
  return (
    <nav aria-label="Filter cycles" className="fm-seg">
      {FILTERS.map((f) => (
        <Link key={f.id} href={cyclesHref(f.id)} aria-current={f.id === active ? "true" : undefined}>
          {f.label}
        </Link>
      ))}
    </nav>
  );
}

/** Pages of 50, newest first. `paged` is true once the reader has left the first page. */
export function CyclePager({ filter, next, paged }: { filter: CycleFilter; next: string | null; paged: boolean }) {
  if (!next && !paged) return null;
  return (
    <nav aria-label="Cycle pages" className="flex gap-2">
      {paged ? <Link href={cyclesHref(filter)} className="fm-btn fm-btn--outline fm-btn--sm">Newest cycles</Link> : null}
      {next ? <Link href={cyclesHref(filter, next)} className="fm-btn fm-btn--outline fm-btn--sm">Older cycles</Link> : null}
    </nav>
  );
}

const LEGEND = [
  { word: "Executed", label: "Executed" },
  { word: "Hold", label: "Hold or Aborted" },
  { word: "Reversed", label: "Reversed, Rejected or Stuck" },
  { word: "Failed", label: "Failed" },
];

export function CycleMap({ rows }: { rows: CycleRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="fm-card grid gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="fm-small">These {rows.length} cycles, oldest to newest</p>
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 fm-small">
          {LEGEND.map((l) => (
            <li key={l.word} className="flex items-center gap-1.5"><span aria-hidden="true" data-word={l.word} className="fm-cell inline-block h-2.5 w-2.5 rounded-sm border" />{l.label}</li>
          ))}
        </ul>
      </div>
      <CycleCells rows={rows} />
    </div>
  );
}

function CycleCells({ rows }: { rows: CycleRow[] }) {
  return (
    <ol aria-label="Cycle map" className="flex flex-wrap gap-1">
      {[...rows].reverse().map((r) => {
        const w = cycleWord(r.events);
        return (
          <li key={r.nonce.toString()}>
            <Link href={`/app/cycles/${r.nonce}`} aria-label={`Cycle ${r.nonce}: ${w}`} data-word={w} className="fm-cell block h-4 w-4 rounded-sm border" />
          </li>
        );
      })}
    </ol>
  );
}

export function CycleTable({ rows }: { rows: CycleRow[] }) {
  if (rows.length === 0) return <p className="text-muted-foreground">No cycles yet. A vault that holds a lot has a short, flat history.</p>;
  return (
    <div className="fm-table-wrap">
      <table aria-label="Cycles" className="fm-table text-sm">
        <thead>
          <tr>
            <th scope="col">Cycle</th>
            <th scope="col">Time</th>
            <th scope="col">Result</th>
            <th scope="col">Proof</th>
            <th scope="col">Amount</th>
            <th scope="col">Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.nonce.toString()} data-nonce={r.nonce.toString()}>
              <td data-label="Cycle" className="mono"><Link href={`/app/cycles/${r.nonce}`} className="underline underline-offset-4">#{r.nonce.toString()}</Link></td>
              <td data-label="Time" className="mono whitespace-nowrap">{r.startedAt.replace("T", " ").slice(0, 16)}</td>
              <td data-label="Result"><Status group="cycle" word={cycleWord(r.events)} /></td>
              <td data-label="Proof"><Status group="proof" word={proofWord(r.verifier, r.obsRecheck)} /></td>
              <td data-label="Amount" className="mono">{r.amountIn === null ? "—" : `${formatUnits(r.amountIn, 6, 2)} USDC`}</td>
              <td data-label="Tx">{r.txHashes[0] ? <Hash value={r.txHashes[0]} label="transaction hash" /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PartialTable({ rows }: { rows: PartialCycle[] }) {
  return (
    <div className="grid gap-3">
      <p><span className="fm-status" data-tone="neutral">Partial</span> History is pending. These rows come straight from the vault&apos;s published decisions.</p>
      <table aria-label="Cycles" className="fm-table text-sm">
        <thead>
          <tr>
            <th scope="col">Cycle</th>
            <th scope="col">Published decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.nonce.toString()} data-nonce={r.nonce.toString()}>
              <td data-label="Cycle" className="mono">#{r.nonce.toString()}</td>
              <td data-label="Published decision" className="mono">{r.decision ?? "No decision to verify"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
