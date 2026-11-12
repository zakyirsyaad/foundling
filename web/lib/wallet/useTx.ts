"use client";

import { useCallback, useEffect, useReducer } from "react";

import { type BuildCtx, type CallName, type WalletTx, buildTx } from "./calls";
import { persistPending, readPending, takePending, txReducer } from "./txState";
import { TxFailed, WalletCancelled, type WalletApi } from "./types";

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
 * An unknown submission outcome keeps the pending record until the person acknowledges it.
 */
export function useTx(wallet: WalletApi | null, ctx: BuildCtx | null, onSettled: () => void) {
  const [state, dispatch] = useReducer(txReducer, { kind: "idle" });

  useEffect(() => {
    // Resume what this page sent before a reload: "Sent" with its hashes, or a warning when the
    // wallet request went out but no hash came back, so the person checks before signing again.
    // The pending record stays until the person acknowledges, succeeds, cancels, or fails on chain.
    const pending = readPending(session(), window.location.pathname);
    if (pending) dispatch(pending.hashes.length ? { type: "resumed", hashes: pending.hashes } : { type: "interrupted" });
    // Runs once, on mount, to resume a transaction sent before a reload.
     
  }, []);

  const run = useCallback(
    async (steps: Step[], partial?: () => "claim-pending" | "moved-to-claimable" | undefined) => {
      if (!wallet || !ctx) {
        dispatch({ type: "rejected", raw: !wallet ? "NO_WALLET" : "TOKEN_MISMATCH" });
        return;
      }
      const path = window.location.pathname;
      let txs: WalletTx[];
      try {
        // Build first: a token mismatch or a bad call is a confirmed refusal, not an unknown send.
        txs = steps.map((s) => buildTx(s.name, s.args, ctx));
      } catch (err) {
        dispatch({ type: "rejected", raw: err instanceof Error ? err.message : String(err) });
        onSettled();
        return;
      }
      dispatch({ type: "submit" });
      persistPending(session(), { path, hashes: [] });
      try {
        const out = await wallet.send(txs);
        const hashes = out.map((o) => o.hash);
        persistPending(session(), { path, hashes });
        dispatch({ type: "sent", hashes });
        dispatch({ type: "settled", partial: out.some((o) => o.refunded) ? "refunded" : partial?.() });
        takePending(session(), path);
      } catch (err) {
        if (err instanceof WalletCancelled) {
          takePending(session(), path);
          dispatch({ type: "cancelled" });
        } else if (err instanceof TxFailed) {
          takePending(session(), path);
          dispatch({ type: "rejected", raw: err.message });
        } else {
          // The wallet may have broadcast before it failed. Keep the intent and do not show a
          // definite rejection that invites a duplicate send.
          dispatch({ type: "unknown", raw: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        onSettled();
      }
    },
    [wallet, ctx, onSettled],
  );

  const acknowledge = useCallback(() => {
    takePending(session(), window.location.pathname);
    dispatch({ type: "acknowledged" });
  }, []);

  return { state, run, acknowledge };
}
