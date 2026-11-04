import { contractErrorSentence } from "@/lib/vault/errors";

export type TxState =
  | { kind: "idle" }
  | { kind: "awaiting-wallet" }
  | { kind: "sent"; hashes: string[] }
  | { kind: "done"; hashes: string[] }
  | { kind: "partial"; hashes: string[]; why: "claim-pending" | "moved-to-claimable" | "refunded" }
  | { kind: "interrupted" }
  | { kind: "cancelled" }
  | { kind: "rejected"; sentence: string; raw: string };

export type TxEvent =
  | { type: "submit" }
  | { type: "cancelled" }
  | { type: "sent"; hashes: string[] }
  | { type: "settled"; partial?: "claim-pending" | "moved-to-claimable" | "refunded" }
  | { type: "resumed"; hashes: string[] }
  | { type: "interrupted" }
  | { type: "rejected"; raw: string };

export function txReducer(state: TxState, ev: TxEvent): TxState {
  switch (ev.type) {
    case "submit":
      return { kind: "awaiting-wallet" };
    case "cancelled":
      return { kind: "cancelled" };
    case "sent":
      return { kind: "sent", hashes: ev.hashes };
    case "settled": {
      const hashes = state.kind === "sent" ? state.hashes : [];
      return ev.partial ? { kind: "partial", hashes, why: ev.partial } : { kind: "done", hashes };
    }
    case "rejected":
      return { kind: "rejected", sentence: contractErrorSentence(ev.raw), raw: ev.raw };
    case "resumed":
      return { kind: "sent", hashes: ev.hashes };
    case "interrupted":
      return { kind: "interrupted" };
  }
}

const KEY = "foundling.pending-tx";

/** What a page sent to the wallet: saved before the request (no hashes) and again after it. */
export interface Pending {
  path: string;
  hashes: string[];
}

/** Kept across a wallet redirect or a reload, so the page resumes instead of sending again. */
export function persistPending(store: Storage | null, pending: Pending): void {
  try {
    store?.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Private mode or blocked storage: the hash is still shown on screen.
  }
}

/** Reads and clears the saved request, but only on the page that sent it. */
export function takePending(store: Storage | null, path: string): Pending | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    if (typeof p?.path !== "string" || !Array.isArray(p.hashes) || !p.hashes.every((h) => typeof h === "string")) return null;
    if (p.path !== path) return null;
    store?.removeItem(KEY);
    return p;
  } catch {
    return null;
  }
}
