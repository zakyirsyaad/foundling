"use client";

import { LimitMeter } from "@/components/fm/LimitMeter";
import { LoadingBlock } from "@/components/fm/LoadingBlock";
import { Stat } from "@/components/fm/Stat";
import { Status } from "@/components/fm/Status";
import type { VaultSnapshot } from "@/lib/chain/types";
import { useVaultSnapshot } from "@/lib/chain/useVaultSnapshot";
import { navUsdc, sharePrice } from "@/lib/chain/vault";
import { formatUnits } from "@/lib/format/units";
import type { CycleRow, HistoryResult, NavPoint } from "@/lib/history/client";
import { cycleWord } from "@/lib/cycles/outcome";
import { limitMeters, sharePriceSinceStart, vaultWord } from "@/lib/vault/overview";
import { SharePriceChart } from "./SharePriceChart";
import { StuckPanelLive } from "./StuckPanelLive";
import { VaultBanner } from "./VaultBanner";

const USDC = 6;

function pct(bps: bigint | null): string {
  if (bps === null) return "—";
  const sign = bps > 0n ? "+" : bps < 0n ? "-" : "";
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${formatUnits(abs, 2, 2)}%`;
}

function usdc(v: bigint | null, decimals = USDC): string {
  return v === null ? "—" : `${formatUnits(v, decimals, 2)} USDC`;
}

export function Overview({ initial, nav, lastCycle = null }: { initial: VaultSnapshot | null; nav: HistoryResult<NavPoint[]>; lastCycle?: CycleRow | null }) {
  const { snapshot: s, unreadable, fresh, loading } = useVaultSnapshot(initial);
  if (!s && loading) return <LoadingBlock rows={4} label="Reading the vault" />;
  if (!s) {
    return (
      <div className="grid gap-6">
        <VaultBanner s={null} unreadable />
      </div>
    );
  }
  const nav0 = navUsdc(s.book, s.price, s.assets);
  const price = sharePrice(nav0, s.totalShares, s.assets.usdcDecimals);
  const firstAt = nav.status === "ok" ? (nav.data[0]?.at ?? null) : null;
  const since = sharePriceSinceStart(price, s.lastNonce, firstAt, s.fetchedAtMs);
  const meters = limitMeters(s);
  const word = vaultWord(s);
  const d = s.assets.usdcDecimals;
  return (
    <div className="grid gap-8">
      <VaultBanner s={s} unreadable={unreadable} />
      <StuckPanelLive s={s} fresh={fresh} onSettled={() => {}} />
      <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="stage-bar">
        <Status group="vault" word={word} />
        <span className="mono text-[13px]">Stage: {s.stage.kind}</span>
        <span className="text-muted-foreground">·</span>
        <span>{s.frozen ? "Frozen" : "Not frozen"}</span>
        <span className="text-muted-foreground">·</span>
        <span>{s.halted ? "Halted" : "Not halted"}</span>
        <span className="text-muted-foreground">·</span>
        <span>{s.accessKeys} access key{s.accessKeys === 1 ? "" : "s"}</span>
        <span className="ml-auto text-[13px] text-muted-foreground">as of block #{s.blockHeight.toString()}</span>
      </div>
      <section aria-label="Vault" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Book" value={usdc(nav0, d)} sub={`${formatUnits(s.book.usdc, d, 2)} USDC + ${formatUnits(s.book.wnear, s.assets.wnearDecimals, 4)} wNEAR`} />
        <Stat label="Share price" value={usdc(price, d)} />
        <Stat label={since.label} value={pct(since.changeBps)} sub={`${since.periodDays === null ? "—" : `${since.periodDays} days`} · ${since.cycles} cycles`} />
        <Stat label="In a swap now" value={s.inflight ? `${formatUnits(s.inflight.amountIn, s.inflight.tokenIn === "Usdc" ? d : s.assets.wnearDecimals, 4)} ${s.inflight.tokenIn === "Usdc" ? "USDC" : "wNEAR"}` : "Nothing"} />
      </section>
      <LastCycle s={s} row={lastCycle} />
      <section aria-labelledby="chart-title" className="rounded-lg border p-5">
        <h2 id="chart-title" className="mb-4 text-lg font-semibold">Share price</h2>
        {nav.status === "ok" ? <SharePriceChart points={nav.data} usdcDecimals={d} /> : <p className="text-sm text-muted-foreground">History is pending. Live numbers above come straight from the chain.</p>}
      </section>
      <section aria-labelledby="limits-title" className="grid gap-6 rounded-lg border p-5">
        <h2 id="limits-title" className="text-lg font-semibold">Limits</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <LimitMeter label="Epoch window" used={meters.epochWindow.used} cap={meters.epochWindow.cap} decimals={d} />
          <LimitMeter label="Ops budget" used={meters.opsBudget.used} cap={meters.opsBudget.cap} decimals={d} />
          <LimitMeter label="TVL against tvl_cap" used={meters.tvl.used} cap={meters.tvl.cap} decimals={d} estimate />
          <LimitMeter label="wNEAR exposure" used={meters.exposure.used} cap={meters.exposure.cap} decimals={d} />
        </div>
        <p className="text-[13px] text-muted-foreground">The TVL figure is an estimate from book value. A deposit over the cap is refunded in full.</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="fm-label">Per-trade cap</dt><dd className="mono">{s.policy.capBps / 100}% · {usdc(s.policy.capUsdc, d)}</dd></div>
          <div><dt className="fm-label">Slippage</dt><dd className="mono">{s.policy.slippageBps / 100}%</dd></div>
          <div><dt className="fm-label">Cooldown</dt><dd className="mono">{s.policy.cooldown.toString()} s</dd></div>
          <div><dt className="fm-label">Price age</dt><dd className="mono">{s.policy.priceMaxAge.toString()} s</dd></div>
          <div><dt className="fm-label">Sell limit</dt><dd className="mono">{s.policy.capSellBps / 100}% of wNEAR</dd></div>
        </dl>
      </section>
    </div>
  );
}

/** Keeper looks down when no cycle started for this long (WEBSITE §4 State: "No cycle since …"). */
const QUIET_MIN_SECONDS = 3600n;

function LastCycle({ s, row }: { s: VaultSnapshot; row: CycleRow | null }) {
  if (!row) return <p className="text-sm">Last cycle #{s.lastNonce.toString()}. History is pending.</p>;
  const started = BigInt(Math.floor(Date.parse(row.startedAt) / 1000));
  const quietAfter = [3n * s.policy.cooldown, QUIET_MIN_SECONDS].reduce((a, b) => (a > b ? a : b));
  const quiet = s.chainTimeSeconds - started > quietAfter;
  return (
    <section aria-label="Last cycle" className="flex flex-wrap items-center gap-3 text-sm" data-testid="last-cycle">
      <span>Last cycle #{row.nonce.toString()}</span>
      <Status group="cycle" word={cycleWord(row.events)} />
      <span className="mono text-[13px] text-muted-foreground">{row.startedAt.replace("T", " ").slice(0, 16)} UTC</span>
      {quiet ? <span>No cycle since {row.startedAt.replace("T", " ").slice(0, 16)} UTC. Deposits wait in the queue; cancelling a deposit and redeem still work.</span> : null}
    </section>
  );
}
