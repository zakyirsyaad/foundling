"use client";

import { useCallback, useEffect, useReducer } from "react";

import { type BuildCtx, type CallName, buildTx } from "./calls";
import { persistPending, takePending, txReducer } from "./txState";
import { WalletCancelled, type WalletApi } from "./types";

export interface Step {
  name: CallName;
  args: object;
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Sends a list of calls in one wallet request and tracks it. Sent hashes are kept in session storage,
 * so a page that reloads after the wallet comes back resumes the status instead of sending again.
 */
export function useTx(wallet: WalletApi | null, ctx: BuildCtx | null, onSettled: () => void) {
  const [state, dispatch] = useReducer(txReducer, { kind: "idle" });

  useEffect(() => {
    // Resume what this page sent before a reload: "Sent" with its hashes, or a warning when the
    // wallet request went out but no hash came back, so the person checks before signing again.
    const pending = takePending(session(), window.location.pathname);
    if (pending) dispatch(pending.hashes.length ? { type: "resumed", hashes: pending.hashes } : { type: "interrupted" });
    // Runs once, on mount, to resume a transaction sent before a reload.
     
  }, []);

  const run = useCallback(
    async (steps: Step[], partial?: () => "claim-pending" | "moved-to-claimable" | undefined) => {
      if (!wallet || !ctx) {
        dispatch({ type: "rejected", raw: !wallet ? "NO_WALLET" : "TOKEN_MISMATCH" });
        return;
      }
      dispatch({ type: "submit" });
      try {
        const txs = steps.map((s) => buildTx(s.name, s.args, ctx));
        const path = window.location.pathname;
        persistPending(session(), { path, hashes: [] });
        const out = await wallet.send(txs);
        const hashes = out.map((o) => o.hash);
        persistPending(session(), { path, hashes });
        dispatch({ type: "sent", hashes });
        dispatch({ type: "settled", partial: out.some((o) => o.refunded) ? "refunded" : partial?.() });
        // Settled: nothing is left to resume, so a later reload starts clean.
        takePending(session(), path);
      } catch (err) {
        takePending(session(), window.location.pathname);
        if (err instanceof WalletCancelled) dispatch({ type: "cancelled" });
        else dispatch({ type: "rejected", raw: err instanceof Error ? err.message : String(err) });
      } finally {
        onSettled();
      }
    },
    [wallet, ctx, onSettled],
  );

  return { state, run };
}
