"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { navUsdc, sharePrice } from "@/lib/chain/vault";
import { formatUnits } from "@/lib/format/units";
import type { NavPoint } from "@/lib/history/client";

const WNEAR_DECIMALS = 24;
const PRICE_DIGITS = 6;

/** The tooltip in the theme's own colours. Recharts' default is a fixed white box, unreadable in dark mode. */
export function PriceTip({ active, label, payload }: { active?: boolean; label?: string | number; payload?: readonly { value?: unknown }[] }) {
  const value = payload?.[0]?.value;
  if (!active || typeof value !== "number") return null;
  return (
    <div data-testid="price-tip" className="grid gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="mono">{value.toFixed(PRICE_DIGITS)} USDC per share</span>
    </div>
  );
}

export function SharePriceChart({ points, usdcDecimals }: { points: NavPoint[]; usdcDecimals: number }) {
  const assets = { usdc: "", wnear: "", rhea: "", poolId: 0n, poolFeeBps: 0, usdcDecimals, wnearDecimals: WNEAR_DECIMALS };
  const data = points
    .map((p) => ({ at: p.at.slice(0, 10), price: sharePrice(navUsdc(p.book, p.oracle, assets), p.totalShares, usdcDecimals) }))
    .filter((p): p is { at: string; price: bigint } => p.price !== null)
    .map((p) => ({ at: p.at, price: Number(formatUnits(p.price, usdcDecimals, PRICE_DIGITS)) }));
  if (data.length < 2) return <p className="text-sm text-muted-foreground">Not enough cycles for a chart yet.</p>;
  return (
    <div className="h-56" role="img" aria-label="Share price by cycle">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="at" tickLine={false} axisLine={false} fontSize={12} minTickGap={48} interval="preserveStartEnd" />
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} fontSize={12} width={56} />
          <Tooltip content={<PriceTip />} cursor={{ stroke: "var(--border)" }} />
          <Line type="monotone" dataKey="price" stroke="var(--foreground)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
