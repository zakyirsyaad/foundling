import type { WalletTx } from "./calls";

export interface TxOutcome {
  hash: string;
  outcome: unknown;
}

export interface WalletApi {
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  accountId(): string | null;
  send(txs: WalletTx[]): Promise<TxOutcome[]>;
  onAccountChange(cb: (id: string | null) => void): () => void;
}

/** Thrown when the user closes or rejects the request in their wallet. */
export class WalletCancelled extends Error {
  constructor() {
    super("cancelled in the wallet");
    this.name = "WalletCancelled";
  }
}
