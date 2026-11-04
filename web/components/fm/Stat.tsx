import type { ReactNode } from "react";

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="fm-stat">
      <div className="fm-label">{label}</div>
      <div className="mono fm-stat-value">{value}</div>
      {sub ? <div className="fm-small">{sub}</div> : null}
    </div>
  );
}
