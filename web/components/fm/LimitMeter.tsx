import { formatUnits } from "@/lib/format/units";

const PERCENT = 100n;

export function LimitMeter({ label, used, cap, decimals, estimate = false, unit, digits = 2 }: { label: string; used: bigint | null; cap: bigint | null; decimals: number; estimate?: boolean; unit?: string; digits?: number }) {
  if (used === null || cap === null) {
    return (
      <div className="fm-meter">
        <div className="fm-label">{label}</div>
        <div className="fm-small">Price unavailable</div>
      </div>
    );
  }
  const pct = cap === 0n ? 100 : Number(((used > cap ? cap : used) * PERCENT) / cap);
  const name = estimate ? `${label} (estimate)` : label;
  const text = `${formatUnits(used, decimals, digits)} / ${formatUnits(cap, decimals, digits)}${unit ? ` ${unit}` : ""}`;
  return (
    <div className="fm-meter">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm">{name}</span>
        <span className="mono text-[13px]">{text}</span>
      </div>
      <div
        role="meter"
        aria-label={name}
        // Percent, not amounts: a yoctoNEAR amount turns into a number like 5e-18, which ARIA rejects.
        aria-valuemin={0}
        aria-valuemax={Number(PERCENT)}
        aria-valuenow={pct}
        aria-valuetext={text}
        className="fm-meter-track"
      >
        <div className="fm-meter-fill" style={{ width: `${pct}%` }} data-near={pct >= 80 ? "true" : undefined} />
      </div>
    </div>
  );
}
