"use client";

import { type ReactNode, useMemo } from "react";

import { Banner } from "@/components/fm/Banner";
import { LoadingBlock } from "@/components/fm/LoadingBlock";
import { config } from "@/config";
import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { usePosition } from "@/lib/chain/usePosition";
import { useVaultSnapshot } from "@/lib/chain/useVaultSnapshot";
import type { BuildCtx } from "@/lib/wallet/calls";
import { useTx } from "@/lib/wallet/useTx";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { depositGate } from "@/lib/vault/deposit";
import { VaultBanner } from "@/features/vault/VaultBanner";
import { ConnectButton } from "@/features/vault/ConnectButton";
import { DepositForm } from "./DepositForm";
import { Positions } from "./Positions";
import { TxStatus } from "./TxStatus";

/** Build context for wallet calls, or null when the site's pinned tokens do not match the vault. */
export function buildCtxFor(s: VaultSnapshot | null): BuildCtx | null {
  if (!s || s.assets.usdc !== config.usdc || s.assets.wnear !== config.wnear) return null;
  return { config, assets: s.assets, storageMin: { vault: s.storageMin, usdc: s.tokenStorageMin.usdc, wnear: s.tokenStorageMin.wnear } };
}

export interface PortfolioSlots {
  exits?: (args: { s: VaultSnapshot; p: Position; ctx: BuildCtx; unreadable: boolean; run: ReturnType<typeof useTx>["run"]; busy: boolean; gasPrice: bigint }) => ReactNode;
  stuck?: (args: { s: VaultSnapshot; fresh: boolean; canSign: boolean; run: ReturnType<typeof useTx>["run"]; busy: boolean; ctx: BuildCtx | null; near: bigint | null; gasPrice: bigint }) => ReactNode;
  crossChain?: (args: { s: VaultSnapshot; p: Position | null; unreadable: boolean; run: ReturnType<typeof useTx>["run"]; busy: boolean; ctx: BuildCtx; gasPrice: bigint }) => ReactNode;
}

export function Portfolio({ slots = {} }: { slots?: PortfolioSlots }) {
  const { snapshot: s, unreadable, fresh, loading } = useVaultSnapshot(null);
  const { wallet, account } = useWallet();
  const { position: p, gasPrice, reload } = usePosition(account, s);
  const ctx = useMemo(() => buildCtxFor(s), [s]);
  const { state, run, acknowledge } = useTx(wallet, ctx, reload);
  const busy = state.kind === "awaiting-wallet" || state.kind === "unknown" || state.kind === "interrupted";
  if (!s) return loading ? <LoadingBlock rows={4} label="Reading the vault" /> : <VaultBanner s={null} unreadable />;
  const gate = depositGate(s, p, unreadable);
  const crossChain = slots.crossChain && config.oneClick && ctx ? slots.crossChain({ s, p, unreadable, run, busy, ctx, gasPrice }) : null;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Portfolio</h1>
        {account ? <span className="mono fm-small">{account}</span> : null}
      </div>
      <VaultBanner s={s} unreadable={unreadable} />
      {!ctx ? <Banner tone="danger" title="Token mismatch">This website pins different token contracts than the vault reports, so it will not ask your wallet to sign anything.</Banner> : null}
      {slots.stuck ? slots.stuck({ s, fresh, canSign: Boolean(account && ctx), run, busy, ctx, near: p?.balances.near ?? null, gasPrice }) : null}
      {!account ? (
        <section className="grid gap-3 rounded-lg border p-5">
          <p>Connect a NEAR wallet to see your position, deposit or leave.</p>
          <div className="justify-self-start"><ConnectButton /></div>
        </section>
      ) : !p ? (
        <LoadingBlock rows={2} label="Reading your position" />
      ) : (
        <>
          <Positions s={s} p={p}>
            {p.pending > 0n && ctx ? (
              <button type="button" disabled={busy} onClick={() => run([{ name: "cancel_deposit", args: {} }])} className="justify-self-start rounded-md border border-input px-3 py-1.5">
                Cancel queued deposit
              </button>
            ) : null}
          </Positions>
          <TxStatus state={state} onAcknowledge={acknowledge} />
        </>
      )}
      {/* Always rendered, so the cross-chain card keeps one place in the tree and its state while the position re-reads. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid gap-6">
          {account && p && ctx ? <DepositForm s={s} p={p} gasPrice={gasPrice} reasons={gate.reasons} ctx={ctx} network={config.network} busy={busy} onSubmit={(steps) => run(steps)} /> : null}
          {crossChain}
        </div>
        <div className="grid gap-6">{account && p && ctx && slots.exits ? slots.exits({ s, p, ctx, unreadable, run, busy, gasPrice }) : null}</div>
      </div>
    </div>
  );
}
