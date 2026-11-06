"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { navUsdc, sharePrice } from "@/lib/chain/vault";
import { formatUnits } from "@/lib/format/units";
import type { NavPoint } from "@/lib/history/client";

const WNEAR_DECIMALS = 24;

export function SharePriceChart({ points, usdcDecimals }: { points: NavPoint[]; usdcDecimals: number }) {
  const assets = { usdc: "", wnear: "", rhea: "", poolId: 0n, poolFeeBps: 0, usdcDecimals, wnearDecimals: WNEAR_DECIMALS };
  const data = points
    .map((p) => ({ at: p.at.slice(0, 10), price: sharePrice(navUsdc(p.book, p.oracle, assets), p.totalShares, usdcDecimals) }))
    .filter((p): p is { at: string; price: bigint } => p.price !== null)
    .map((p) => ({ at: p.at, price: Number(formatUnits(p.price, usdcDecimals, 6)) }));
  if (data.length < 2) return <p className="text-sm text-muted-foreground">Not enough cycles for a chart yet.</p>;
  return (
    <div className="h-56" role="img" aria-label="Share price by cycle">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="at" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} fontSize={12} width={56} />
          <Tooltip />
          <Line type="monotone" dataKey="price" stroke="var(--foreground)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
