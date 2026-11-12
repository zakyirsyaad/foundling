import { NearConnector } from "@hot-labs/near-connect";

import type { DeploymentConfig } from "@/config/deployment";
import { isNearAccount } from "@/lib/format/shell";
import type { WalletTx } from "./calls";
import { type TxOutcome, type WalletApi, TxFailed, WalletCancelled } from "./types";

type Status = { Failure?: unknown; SuccessValue?: string };
type Outcome = { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: Status; receipts_outcome?: { outcome?: { status?: Status } }[] };

function hashOf(o: unknown): string {
  const x = o as Outcome;
  return x.transaction?.hash ?? x.transaction_outcome?.id ?? "";
}

function panicText(failure: unknown): string {
  const text = JSON.stringify(failure);
  return /Smart contract panicked: [^"\\]+/.exec(text)?.[0] ?? `Transaction failed: ${text}`;
}

/** near-connect resolves even when the chain rejected the call; look at every status. */
function failureOf(o: unknown): string | null {
  const x = o as Outcome;
  const failed = [x.status, ...(x.receipts_outcome ?? []).map((r) => r.outcome?.status)].find((st) => st && "Failure" in st);
  return failed ? panicText(failed.Failure) : null;
}

function refundedInFull(o: unknown, tx: WalletTx): boolean {
  const value = (o as Outcome).status?.SuccessValue;
  if (tx.methodName !== "ft_transfer_call" || !value) return false;
  try {
    return JSON.parse(atob(value)) === "0";
  } catch {
    return false;
  }
}

function isCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(rejected|cancel(?:l?ed)?|closed by user|user closed|denied by user|user rejected)\b/i.test(msg);
}

/** near-connect with its default wallet manifest (no `manifest` option) and the deployment's network. */
export function createWallet(cfg: DeploymentConfig, cspNonce: string): WalletApi {
  const connector = new NearConnector({ network: cfg.network, cspNonce, autoConnect: true });
  let account: string | null = null;
  const listeners = new Set<(id: string | null) => void>();
  // Executor code is third-party and unpinned: an id that is not a NEAR account is never used.
  const emit = (raw: string | null) => {
    const id = raw !== null && isNearAccount(raw) ? raw : null;
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
      if (!id || !isNearAccount(id)) throw new WalletCancelled();
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
        const hashes = outcomes.map(hashOf).filter((hash) => hash !== "");
        const failure = outcomes.map(failureOf).find((f) => f !== null);
        if (failure) throw new TxFailed(failure, hashes);
        return outcomes.map((o, i) => ({ hash: hashOf(o), outcome: o, refunded: refundedInFull(o, txs[i]!) }));
      } catch (err) {
        // A reported on-chain failure is confirmed; it must not be re-read as a wallet cancel
        // when its panic text happens to contain "cancelled".
        if (err instanceof TxFailed) throw err;
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
