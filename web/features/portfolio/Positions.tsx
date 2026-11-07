import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { formatUnits } from "@/lib/format/units";

export function Positions({ s, p, children }: { s: VaultSnapshot; p: Position; children?: React.ReactNode }) {
  const d = s.assets.usdcDecimals;
  return (
    <section aria-labelledby="positions-title" className="grid gap-3">
      <h2 id="positions-title" className="sr-only">Your position</h2>
      <dl className="stat-strip stat-strip--3">
        <div data-testid="shares" className="fm-stat">
          <dt className="fm-label">Shares</dt>
          <dd className="mono fm-stat-value">{p.shares.toString()}</dd>
        </div>
        <div data-testid="queue" className="fm-stat">
          <dt className="fm-label">Queue</dt>
          <dd className="mono fm-stat-value">{formatUnits(p.pending, d, 2)} USDC</dd>
          {p.pending > 0n ? <dd className="fm-small">Shares mint at the next cycle.</dd> : null}
        </div>
        <div data-testid="claimable" className="fm-stat">
          <dt className="fm-label">Claimable</dt>
          <dd className="mono fm-stat-value">{formatUnits(p.claimable.usdc, d, 2)} USDC</dd>
          <dd className="fm-small mono">{formatUnits(p.claimable.wnear, s.assets.wnearDecimals, 4)} wNEAR</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}
