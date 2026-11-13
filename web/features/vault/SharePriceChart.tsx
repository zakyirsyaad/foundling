"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { navUsdc, sharePrice } from "@/lib/chain/vault";
import { formatUnits } from "@/lib/format/units";
import type { NavPoint } from "@/lib/history/client";

const WNEAR_DECIMALS = 24;
const PRICE_DIGITS = 6;

export interface ChartPoint {
  /** The cycle's full timestamp. It is the x key, so it must differ for every point: the chart finds the hovered point by it. */
  at: string;
  nonce: string;
  price: number;
}

/** One point per cycle that has a share price. A vault runs many cycles a day, so the key is the time, not the date. */
export function chartPoints(points: NavPoint[], usdcDecimals: number): ChartPoint[] {
  const assets = { usdc: "", wnear: "", rhea: "", poolId: 0n, poolFeeBps: 0, usdcDecimals, wnearDecimals: WNEAR_DECIMALS };
  return points.flatMap((p) => {
    const price = sharePrice(navUsdc(p.book, p.oracle, assets), p.totalShares, usdcDecimals);
    return price === null ? [] : [{ at: p.at, nonce: p.nonce.toString(), price: Number(formatUnits(price, usdcDecimals, PRICE_DIGITS)) }];
  });
}

/** `2026-11-13T14:21:57Z` as `11-13 14:21`, in UTC like every other time on the site. */
export function axisLabel(at: string): string {
  return `${at.slice(5, 10)} ${at.slice(11, 16)}`;
}

const isChartPoint = (v: unknown): v is ChartPoint => typeof v === "object" && v !== null && typeof (v as ChartPoint).at === "string" && typeof (v as ChartPoint).nonce === "string";

/** The tooltip in the theme's own colours. Recharts' default is a fixed white box, unreadable in dark mode. */
export function PriceTip({ active, label, payload }: { active?: boolean; label?: string | number; payload?: readonly { value?: unknown; payload?: unknown }[] }) {
  const value = payload?.[0]?.value;
  if (!active || typeof value !== "number") return null;
  const point = payload?.[0]?.payload;
  return (
    <div data-testid="price-tip" className="grid gap-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <span className="text-muted-foreground">{isChartPoint(point) ? `Cycle ${point.nonce} · ${point.at.slice(0, 10)} ${point.at.slice(11, 16)} UTC` : label}</span>
      <span className="mono">{value.toFixed(PRICE_DIGITS)} USDC per share</span>
    </div>
  );
}

export function SharePriceChart({ points, usdcDecimals }: { points: NavPoint[]; usdcDecimals: number }) {
  const data = chartPoints(points, usdcDecimals);
  if (data.length < 2) return <p className="text-sm text-muted-foreground">Not enough cycles for a chart yet.</p>;
  return (
    <div className="h-56" role="img" aria-label="Share price by cycle">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="at" tickFormatter={axisLabel} tickLine={false} axisLine={false} fontSize={12} minTickGap={48} interval="preserveStartEnd" />
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} fontSize={12} width={56} />
          <Tooltip content={<PriceTip />} cursor={{ stroke: "var(--border)" }} />
          <Line type="monotone" dataKey="price" stroke="var(--foreground)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
