import { NearConnector } from "@hot-labs/near-connect";

import type { DeploymentConfig } from "@/config/deployment";
import type { WalletTx } from "./calls";
import { type TxOutcome, type WalletApi, WalletCancelled } from "./types";

type Outcome = { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };

function hashOf(o: unknown): string {
  const x = o as Outcome;
  return x.transaction?.hash ?? x.transaction_outcome?.id ?? "";
}

function isCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /reject|cancel|closed|denied|user/i.test(msg);
}

/** near-connect with its default wallet manifest (no `manifest` option) and the deployment's network. */
export function createWallet(cfg: DeploymentConfig, cspNonce: string): WalletApi {
  const connector = new NearConnector({ network: cfg.network, cspNonce, autoConnect: true });
  let account: string | null = null;
  const listeners = new Set<(id: string | null) => void>();
  const emit = (id: string | null) => {
    account = id;
    for (const l of listeners) l(id);
  };
  connector.on("wallet:signIn", (e) => emit(e.accounts[0]?.accountId ?? null));
  connector.on("wallet:signOut", () => emit(null));
  connector
    .getConnectedWallet()
    .then((c) => emit(c.accounts[0]?.accountId ?? null))
    .catch(() => emit(null));

  return {
    async connect() {
      const wallet = await connector.connect();
      const accounts = await wallet.getAccounts();
      const id = accounts[0]?.accountId;
      if (!id) throw new WalletCancelled();
      emit(id);
      return id;
    },
    async disconnect() {
      await connector.disconnect();
      emit(null);
    },
    accountId: () => account,
    async send(txs: WalletTx[]): Promise<TxOutcome[]> {
      const wallet = await connector.wallet();
      try {
        const outcomes = await wallet.signAndSendTransactions({
          network: cfg.network,
          transactions: txs.map((t) => ({
            receiverId: t.receiverId,
            actions: [{ type: "FunctionCall" as const, params: { methodName: t.methodName, args: t.args, gas: t.gas.toString(), deposit: t.deposit.toString() } }],
          })),
        });
        return outcomes.map((o) => ({ hash: hashOf(o), outcome: o }));
      } catch (err) {
        if (isCancel(err)) throw new WalletCancelled();
        throw err;
      }
    },
    onAccountChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
