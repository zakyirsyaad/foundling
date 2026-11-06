import { formatUnits } from "@/lib/format/units";

const PERCENT = 100n;

export function LimitMeter({ label, used, cap, decimals, estimate = false, unit }: { label: string; used: bigint | null; cap: bigint | null; decimals: number; estimate?: boolean; unit?: string }) {
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
  return (
    <div className="fm-meter">
      <div className="fm-label">{name}</div>
      <div
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={Number(formatUnits(cap, decimals))}
        aria-valuenow={Number(formatUnits(used > cap ? cap : used, decimals))}
        className="fm-meter-track"
      >
        <div className="fm-meter-fill" style={{ width: `${pct}%` }} data-near={pct >= 80 ? "true" : undefined} />
      </div>
      <div className="mono fm-small">
        {formatUnits(used, decimals, 2)} / {formatUnits(cap, decimals, 2)}{unit ? ` ${unit}` : ""}
      </div>
    </div>
  );
}
