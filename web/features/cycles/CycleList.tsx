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

export function CycleFilterBar({ active }: { active: CycleFilter }) {
  return (
    <nav aria-label="Filter cycles" className="flex gap-2">
      {FILTERS.map((f) => (
        <Link key={f.id} href={f.id === "all" ? "/app/cycles" : `/app/cycles?filter=${f.id}`} aria-current={f.id === active ? "true" : undefined} className={`rounded-md border px-3 py-1 text-[13px] ${f.id === active ? "border-foreground font-medium" : "border-input text-muted-foreground"}`}>
          {f.label}
        </Link>
      ))}
    </nav>
  );
}

export function CycleMap({ rows }: { rows: CycleRow[] }) {
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
    <table aria-label="Cycles" className="w-full text-sm">
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
            <td className="mono"><Link href={`/app/cycles/${r.nonce}`}>#{r.nonce.toString()}</Link></td>
            <td className="mono">{r.startedAt.replace("T", " ").slice(0, 16)}</td>
            <td><Status group="cycle" word={cycleWord(r.events)} /></td>
            <td><Status group="proof" word={proofWord(r.verifier, r.obsRecheck)} /></td>
            <td className="mono">{r.amountIn === null ? "—" : `${formatUnits(r.amountIn, 6, 2)} USDC`}</td>
            <td>{r.txHashes[0] ? <Hash value={r.txHashes[0]} label="transaction hash" /> : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PartialTable({ rows }: { rows: PartialCycle[] }) {
  return (
    <div className="grid gap-3">
      <p><span className="fm-status" data-tone="neutral">Partial</span> History is pending. These rows come straight from the vault&apos;s published decisions.</p>
      <table aria-label="Cycles" className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col">Cycle</th>
            <th scope="col">Published decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.nonce.toString()} data-nonce={r.nonce.toString()}>
              <td className="mono">#{r.nonce.toString()}</td>
              <td className="mono">{r.decision ?? "No decision to verify"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
