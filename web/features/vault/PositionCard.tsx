"use client";

import Link from "next/link";

import type { VaultSnapshot } from "@/lib/chain/types";
import { usePosition } from "@/lib/chain/usePosition";
import { formatUnits } from "@/lib/format/units";
import { positionValue } from "@/lib/vault/overview";
import { useWallet } from "@/lib/wallet/WalletProvider";

/** The visitor's own position on the Overview, so the first screen answers "what do I have here?". */
export function PositionCard({ s, nav }: { s: VaultSnapshot; nav: bigint | null }) {
  const { account } = useWallet();
  const { position: p } = usePosition(account, s);
  const d = s.assets.usdcDecimals;
  if (!account) {
    return (
      <section aria-labelledby="position-title" data-testid="position-card" className="fm-card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-5">
        <div className="grid gap-1">
          <h2 id="position-title" className="fm-label">Your position</h2>
          <p className="text-base font-semibold">Connect a wallet to see your shares.</p>
          <p className="fm-small">Everything else on this page is public and needs no wallet.</p>
        </div>
        <Link href="/app/portfolio" className="fm-btn fm-btn--outline">Open Portfolio</Link>
      </section>
    );
  }
  if (!p) {
    return (
      <section aria-labelledby="position-title" data-testid="position-card" className="fm-card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-5">
        <div className="grid gap-1">
          <h2 id="position-title" className="fm-label">Your position</h2>
          {/* A failed read and a pending one look the same here, so the way forward is always shown. */}
          <p className="fm-small">Reading your position. If it does not appear, Portfolio reads it again.</p>
        </div>
        <Link href="/app/portfolio" className="fm-btn fm-btn--outline">Open Portfolio</Link>
      </section>
    );
  }
  const value = positionValue(nav, p.shares, s.totalShares);
  return (
    <section aria-labelledby="position-title" data-testid="position-card" className="fm-card flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-5">
      <div className="grid gap-1">
        <h2 id="position-title" className="fm-label">Your position</h2>
        <p className="mono text-[28px] font-medium leading-tight tracking-[-0.03em]" data-testid="position-value">{value === null ? "—" : `${formatUnits(value, d, 2)} USDC`}</p>
        <p className="fm-small">
          {p.shares === 0n ? "No shares yet" : "Your share of the book, at the current price"}
          {p.pending > 0n ? ` · ${formatUnits(p.pending, d, 2)} USDC queued for the next cycle` : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link href="/app/portfolio#deposit-title" className="fm-btn fm-btn--primary">Deposit</Link>
        <Link href="/app/portfolio#redeem-title" className="fm-btn fm-btn--outline">Redeem</Link>
      </div>
    </section>
  );
}
