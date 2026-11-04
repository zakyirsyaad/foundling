import type { VaultSnapshot } from "@/lib/chain/types";
import { SHARES_PER_UNIT, navUsdc } from "@/lib/chain/vault";
import { recoveryAction } from "./recovery";

export type VaultWord = "Live" | "Stuck" | "Halted" | "Frozen" | "Not ready";
export interface Meter {
  used: bigint | null;
  cap: bigint | null;
  estimate: boolean;
}

/** App data older than this is treated as unreadable (WEBSITE §4 State). */
export const STALE_AFTER_MS = 60_000;
const BPS = 10_000n;
const DAY_MS = 86_400_000;
/** The first share price: exactly 1 USDC in base units. */
const START_PRICE = SHARES_PER_UNIT;

export function vaultWord(s: VaultSnapshot): VaultWord {
  if (s.halted) return "Halted";
  if (s.frozen) return "Frozen";
  const stuck = s.stage.kind === "Stuck" || recoveryAction(s.stage, s.inflight, s.policy, s.chainTimeSeconds, s.blockHeight).advance;
  if (stuck) return "Stuck";
  if (!s.setupDone || !s.selftestPassed) return "Not ready";
  return "Live";
}

export function dataAge(s: VaultSnapshot, nowMs: number): { ageSeconds: number; unreadable: boolean } {
  const ms = Math.max(0, nowMs - s.fetchedAtMs);
  return { ageSeconds: Math.floor(ms / 1000), unreadable: ms > STALE_AFTER_MS };
}

/** Change in share price since the first deposit, in basis points. Never annualised. */
export function sharePriceSinceStart(price: bigint | null, lastNonce: bigint, firstNavAt: string | null, nowMs: number) {
  const changeBps = price === null ? null : ((price - START_PRICE) * BPS) / START_PRICE;
  const start = firstNavAt ? Date.parse(firstNavAt) : Number.NaN;
  const periodDays = Number.isNaN(start) ? null : Math.floor((nowMs - start) / DAY_MS);
  return { label: "Share price since start" as const, changeBps, periodDays, cycles: lastNonce };
}

const ofBps = (amount: bigint, bps: number) => (amount * BigInt(bps)) / BPS;

export function limitMeters(s: VaultSnapshot): { epochWindow: Meter; opsBudget: Meter; tvl: Meter; exposure: Meter } {
  const nav = navUsdc(s.book, s.price, s.assets);
  const wnearValue = nav === null ? null : nav - s.book.usdc;
  const epochCap = nav === null ? null : [ofBps(nav, s.policy.epochCapBps), s.policy.epochCapUsdc].reduce((a, b) => (a < b ? a : b));
  return {
    epochWindow: { used: epochCap === null ? null : s.windowUsed.usdc, cap: epochCap, estimate: false },
    opsBudget: { used: s.opsSpent, cap: s.policy.opsBudget, estimate: false },
    tvl: { used: nav, cap: nav === null ? null : s.policy.tvlCap, estimate: true },
    exposure: { used: wnearValue, cap: nav === null ? null : ofBps(nav, s.policy.maxRiskBps), estimate: false },
  };
}
