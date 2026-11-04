"use client";

import { type ReactNode, useMemo } from "react";

import { Banner } from "@/components/fm/Banner";
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
  exits?: (args: { s: VaultSnapshot; p: Position; ctx: BuildCtx; unreadable: boolean; run: ReturnType<typeof useTx>["run"]; busy: boolean }) => ReactNode;
  stuck?: (args: { s: VaultSnapshot; fresh: boolean; ctx: BuildCtx | null; run: ReturnType<typeof useTx>["run"]; busy: boolean }) => ReactNode;
  crossChain?: (args: { s: VaultSnapshot; p: Position | null; unreadable: boolean }) => ReactNode;
}

export function Portfolio({ slots = {} }: { slots?: PortfolioSlots }) {
  const { snapshot: s, unreadable, fresh } = useVaultSnapshot(null);
  const { wallet, account } = useWallet();
  const { position: p, gasPrice, reload } = usePosition(account, s);
  const ctx = useMemo(() => buildCtxFor(s), [s]);
  const { state, run } = useTx(wallet, ctx, reload);
  const busy = state.kind === "awaiting-wallet";
  if (!s) return <VaultBanner s={null} unreadable />;
  const gate = depositGate(s, p, unreadable);
  return (
    <div className="grid gap-6">
      <VaultBanner s={s} unreadable={unreadable} />
      {!ctx ? <Banner tone="danger" title="Token mismatch">This website pins different token contracts than the vault reports, so it will not ask your wallet to sign anything.</Banner> : null}
      {slots.stuck ? slots.stuck({ s, fresh, ctx, run, busy }) : null}
      {!account ? (
        <section className="grid gap-3 rounded-lg border p-5">
          <p>Connect a NEAR wallet to see your position, deposit or leave.</p>
          <ConnectButton />
        </section>
      ) : !p ? (
        <p role="status">Reading your position…</p>
      ) : (
        <>
          <Positions s={s} p={p}>
            {p.pending > 0n && ctx ? (
              <button type="button" disabled={busy} onClick={() => run([{ name: "cancel_deposit", args: {} }])} className="justify-self-start rounded-md border border-input px-3 py-1.5">
                Cancel queued deposit
              </button>
            ) : null}
          </Positions>
          <TxStatus state={state} />
          {ctx ? <DepositForm s={s} p={p} gasPrice={gasPrice} reasons={gate.reasons} ctx={ctx} network={config.network} busy={busy} onSubmit={(steps) => run(steps)} /> : null}
          {ctx && slots.exits ? slots.exits({ s, p, ctx, unreadable, run, busy }) : null}
        </>
      )}
      {slots.crossChain ? slots.crossChain({ s, p, unreadable }) : null}
    </div>
  );
}
