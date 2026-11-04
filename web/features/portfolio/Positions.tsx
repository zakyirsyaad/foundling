import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { formatUnits } from "@/lib/format/units";

export function Positions({ s, p, children }: { s: VaultSnapshot; p: Position; children?: React.ReactNode }) {
  const d = s.assets.usdcDecimals;
  return (
    <section aria-labelledby="positions-title" className="grid gap-4 rounded-lg border p-5">
      <h2 id="positions-title" className="text-lg font-semibold">Your position</h2>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div data-testid="queue">
          <dt className="fm-label">Queue</dt>
          <dd className="mono">{formatUnits(p.pending, d, 2)} USDC</dd>
          {p.pending > 0n ? <dd className="text-[13px] text-muted-foreground">Shares mint at the next cycle.</dd> : null}
        </div>
        <div data-testid="shares">
          <dt className="fm-label">Shares</dt>
          <dd className="mono">{p.shares.toString()}</dd>
        </div>
        <div data-testid="claimable">
          <dt className="fm-label">Claimable</dt>
          <dd className="mono">{formatUnits(p.claimable.usdc, d, 2)} USDC · {formatUnits(p.claimable.wnear, s.assets.wnearDecimals, 4)} wNEAR</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}
