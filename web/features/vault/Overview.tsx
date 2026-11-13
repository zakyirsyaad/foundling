"use client";

import Link from "next/link";

import { Card } from "@/components/fm/Card";
import { truncateMiddle } from "@/components/fm/Hash";
import { LimitMeter } from "@/components/fm/LimitMeter";
import { LoadingBlock } from "@/components/fm/LoadingBlock";
import { Stat } from "@/components/fm/Stat";
import { Status } from "@/components/fm/Status";
import type { VaultSnapshot } from "@/lib/chain/types";
import { useVaultSnapshot } from "@/lib/chain/useVaultSnapshot";
import { navUsdc, sharePrice } from "@/lib/chain/vault";
import { NEAR_DECIMALS, formatUnits } from "@/lib/format/units";
import type { CycleRow, HistoryResult, NavPoint } from "@/lib/history/client";
import { cycleWord } from "@/lib/cycles/outcome";
import { base58ToHex } from "@/lib/proof/facts";
import { limitMeters, sharePriceSinceStart, vaultHeadline, vaultWord } from "@/lib/vault/overview";
import { PositionCard } from "./PositionCard";
import { SharePriceChart } from "./SharePriceChart";
import { StuckPanelLive } from "./StuckPanelLive";
import { VaultBanner } from "./VaultBanner";

/** The ops budget and what it has spent are native NEAR, not USDC; a cycle costs about 0.0014 NEAR. */
const NEAR_DIGITS = 4;

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
  const d = s.assets.usdcDecimals;
  return (
    <div className="grid gap-6">
      <VaultBanner s={s} unreadable={unreadable} />
      <StuckPanelLive s={s} fresh={fresh} onSettled={() => {}} />
      <div className="grid gap-2" data-testid="stage-bar">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Status group="vault" word={vaultWord(s)} />
          <span className="fm-small">
            <span className="mono">Stage: {s.stage.kind}</span> · {s.frozen ? "Frozen" : "Not frozen"} · {s.halted ? "Halted" : "Not halted"}
          </span>
          <span className="fm-small ml-auto">as of block #{s.blockHeight.toString()}</span>
        </div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.035em]">{vaultHeadline(s)}</h1>
      </div>
      <PositionCard s={s} nav={nav0} />
      <section aria-label="Vault" className="stat-strip stat-strip--4">
        <Stat label="Book" value={usdc(nav0, d)} sub={`${formatUnits(s.book.usdc, d, 2)} USDC + ${formatUnits(s.book.wnear, s.assets.wnearDecimals, 4)} wNEAR`} />
        <Stat label="Share price" value={price === null ? "—" : `${formatUnits(price, d, 6)} USDC`} sub="USDC per share" />
        <Stat label={since.label} value={pct(since.changeBps)} sub={`${since.periodDays === null ? "—" : `${since.periodDays} days`} · ${since.cycles} cycles`} />
        <Stat label="In a swap now" value={s.inflight ? `${formatUnits(s.inflight.amountIn, s.inflight.tokenIn === "Usdc" ? d : s.assets.wnearDecimals, 4)} ${s.inflight.tokenIn === "Usdc" ? "USDC" : "wNEAR"}` : "Nothing"} sub={s.inflight ? "Swap running" : "No swap running"} />
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card id="chart-title" title="Share price" aside="USDC per share">
          <div className="p-5">{nav.status === "ok" ? <SharePriceChart points={nav.data} usdcDecimals={d} /> : <p className="text-sm text-muted-foreground">History is pending. Live numbers above come straight from the chain.</p>}</div>
        </Card>
        <Limits s={s} />
      </div>
      <LastCycle s={s} row={lastCycle} />
      <p className="fm-small">
        {s.accessKeys} access key{s.accessKeys === 1 ? "" : "s"} · code hash <span className="mono">{truncateMiddle(base58ToHex(s.account.codeHash) ?? s.account.codeHash)}</span> · strategy WASM <span className="mono">{truncateMiddle(s.agent.wasmHash)}</span> · <Link href="/proof" className="underline underline-offset-4">How to check these</Link>
      </p>
    </div>
  );
}

function Limits({ s }: { s: VaultSnapshot }) {
  const meters = limitMeters(s);
  const d = s.assets.usdcDecimals;
  return (
    <Card id="limits-title" title="Limits" aside="Set in the contract">
      <div className="grid gap-5 p-5">
        <LimitMeter label="Epoch window" used={meters.epochWindow.used} cap={meters.epochWindow.cap} decimals={d} />
        <LimitMeter label="Ops budget" used={meters.opsBudget.used} cap={meters.opsBudget.cap} decimals={NEAR_DECIMALS} digits={NEAR_DIGITS} unit="NEAR" />
        <LimitMeter label="TVL against tvl_cap" used={meters.tvl.used} cap={meters.tvl.cap} decimals={d} estimate />
        <LimitMeter label="wNEAR exposure" used={meters.exposure.used} cap={meters.exposure.cap} decimals={d} />
        <p className="fm-small">The TVL figure is an estimate from book value. A deposit over the cap is refunded in full.</p>
        <dl className="fm-kv border-t pt-4">
          <dt>Per-trade cap</dt><dd className="mono">{s.policy.capBps / 100}% · {usdc(s.policy.capUsdc, d)}</dd>
          <dt>Slippage</dt><dd className="mono">{s.policy.slippageBps / 100}%</dd>
          <dt>Cooldown</dt><dd className="mono">{s.policy.cooldown.toString()} s</dd>
          <dt>Price age</dt><dd className="mono">{s.policy.priceMaxAge.toString()} s</dd>
          <dt>Sell limit</dt><dd className="mono">{s.policy.capSellBps / 100}% of wNEAR</dd>
        </dl>
      </div>
    </Card>
  );
}

/** Keeper looks down when no cycle started for this long (WEBSITE §4 State: "No cycle since …"). */
const QUIET_MIN_SECONDS = 3600n;

function LastCycle({ s, row }: { s: VaultSnapshot; row: CycleRow | null }) {
  if (!row) {
    return (
      <Card id="last-cycle-title" title="Last cycle">
        <p className="p-5 text-sm">Last cycle #{s.lastNonce.toString()}. History is pending.</p>
      </Card>
    );
  }
  const started = BigInt(Math.floor(Date.parse(row.startedAt) / 1000));
  const quietAfter = [3n * s.policy.cooldown, QUIET_MIN_SECONDS].reduce((a, b) => (a > b ? a : b));
  const quiet = s.chainTimeSeconds - started > quietAfter;
  const when = `${row.startedAt.replace("T", " ").slice(0, 16)} UTC`;
  return (
    <Card id="last-cycle-title" title="Last cycle" aside={<Link href={`/app/cycles/${row.nonce}`} className="font-medium text-foreground">View cycle {row.nonce.toString()}</Link>}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 p-5 text-sm" data-testid="last-cycle">
        <span>Last cycle #{row.nonce.toString()}</span>
        <Status group="cycle" word={cycleWord(row.events)} />
        <span className="mono text-[13px] text-muted-foreground">{when}</span>
        {quiet ? <span>No cycle since {when}. Deposits wait in the queue; cancelling a deposit and redeem still work.</span> : null}
      </div>
    </Card>
  );
}
