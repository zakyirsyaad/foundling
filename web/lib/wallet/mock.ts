/**
 * __FOUNDLING_MOCK_WALLET__ — test build only. CI fails if this marker reaches a production build.
 * Signs nothing: it posts each call to the mock server, which applies it to the scenario.
 */
import type { WalletTx } from "./calls";
import { type TxOutcome, type WalletApi, WalletCancelled } from "./types";

const MOCK = "http://localhost:3199";
const ACCOUNT_KEY = "foundling.mock.account";

declare global {
  interface Window {
    __mockWallet?: { sent: WalletTx[]; next?: "cancel" | `contract:${string}` };
  }
}

export function createMockWallet(): WalletApi {
  const state = (window.__mockWallet ??= { sent: [] });
  let account: string | null = window.localStorage.getItem(ACCOUNT_KEY);
  const listeners = new Set<(id: string | null) => void>();
  const set = (id: string | null) => {
    account = id;
    if (id) window.localStorage.setItem(ACCOUNT_KEY, id);
    else window.localStorage.removeItem(ACCOUNT_KEY);
    for (const l of listeners) l(id);
  };
  return {
    async connect() {
      set(window.localStorage.getItem("foundling.mock.next-account") ?? "alice.testnet");
      return account!;
    },
    async disconnect() {
      set(null);
    },
    accountId: () => account,
    async send(txs: WalletTx[]): Promise<TxOutcome[]> {
      const next = state.next;
      state.next = undefined;
      if (next === "cancel") throw new WalletCancelled();
      state.sent.push(...txs);
      const res = await fetch(`${MOCK}/__tx`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signer: account, fail: next?.startsWith("contract:") ? next.slice(9) : null, txs: txs.map((t) => ({ ...t, gas: t.gas.toString(), deposit: t.deposit.toString() })) }),
      });
      const body = (await res.json()) as { hashes?: string[]; error?: string };
      if (!res.ok) throw new Error(`Smart contract panicked: ${body.error ?? "unknown"}`);
      return (body.hashes ?? []).map((hash) => ({ hash, outcome: null }));
    },
    onAccountChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
