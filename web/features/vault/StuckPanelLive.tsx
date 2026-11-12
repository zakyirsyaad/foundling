"use client";

import { useMemo } from "react";

import { buildCtxFor } from "@/features/portfolio/Portfolio";
import type { VaultSnapshot } from "@/lib/chain/types";
import { useTx } from "@/lib/wallet/useTx";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { TxStatus } from "@/features/portfolio/TxStatus";
import { StuckPanel } from "./StuckPanel";

/** The stuck panel wired to the connected wallet, for the Overview page. */
export function StuckPanelLive({ s, fresh, onSettled }: { s: VaultSnapshot; fresh: boolean; onSettled: () => void }) {
  const { wallet, account } = useWallet();
  const ctx = useMemo(() => buildCtxFor(s), [s]);
  const { state, run, acknowledge } = useTx(wallet, ctx, onSettled);
  const busy = state.kind === "awaiting-wallet" || state.kind === "unknown" || state.kind === "interrupted";
  return (
    <>
      <StuckPanel s={s} fresh={fresh} run={run} busy={busy} canSign={Boolean(account && ctx)} />
      <TxStatus state={state} onAcknowledge={acknowledge} />
    </>
  );
}
