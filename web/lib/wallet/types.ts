import type { WalletTx } from "./calls";

export interface TxOutcome {
  hash: string;
  outcome: unknown;
  /** ft_transfer_call that the receiver returned in full (the deposit was refused, no event). */
  refunded?: boolean;
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

/** An on-chain failure the wallet reported after the transaction was broadcast. */
export class TxFailed extends Error {
  constructor(message: string, readonly hashes: string[] = []) {
    super(message);
    this.name = "TxFailed";
  }
}
