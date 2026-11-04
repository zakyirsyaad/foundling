import { contractErrorSentence } from "@/lib/vault/errors";

export type TxState =
  | { kind: "idle" }
  | { kind: "awaiting-wallet" }
  | { kind: "sent"; hashes: string[] }
  | { kind: "done"; hashes: string[] }
  | { kind: "partial"; hashes: string[]; why: "claim-pending" | "moved-to-claimable" }
  | { kind: "cancelled" }
  | { kind: "rejected"; sentence: string; raw: string };

export type TxEvent =
  | { type: "submit" }
  | { type: "cancelled" }
  | { type: "sent"; hashes: string[] }
  | { type: "settled"; partial?: "claim-pending" | "moved-to-claimable" }
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
  }
}

const KEY = "foundling.pending-tx";

/** Keeps sent hashes across a wallet redirect or a reload, so the page resumes instead of resending. */
export function persistPending(store: Storage | null, hashes: string[]): void {
  try {
    store?.setItem(KEY, JSON.stringify(hashes));
  } catch {
    // Private mode or blocked storage: the hash is still shown on screen.
  }
}

export function takePending(store: Storage | null): string[] {
  try {
    const raw = store?.getItem(KEY);
    store?.removeItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.every((h) => typeof h === "string") ? parsed : [];
  } catch {
    return [];
  }
}
