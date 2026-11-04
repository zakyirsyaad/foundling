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
    const hashes = takePending(session());
    if (hashes.length) {
      dispatch({ type: "sent", hashes });
      dispatch({ type: "settled" });
    }
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
        const out = await wallet.send(txs);
        const hashes = out.map((o) => o.hash);
        // Kept until the next page load reads it once, so a reload resumes this status instead of resending.
        persistPending(session(), hashes);
        dispatch({ type: "sent", hashes });
        dispatch({ type: "settled", partial: partial?.() });
      } catch (err) {
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
