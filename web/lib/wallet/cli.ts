import type { Network } from "@/config/deployment";
import { isNearAccount, shellQuote } from "@/lib/format/shell";
import type { WalletTx } from "./calls";

const TGAS = 10n ** 12n;

/** The near-cli command that does the same as a wallet call, so no action depends on this website. */
export function cliCommand(tx: WalletTx, signer: string | null, network: Network): string {
  if (signer !== null && !isNearAccount(signer)) throw new Error(`not a NEAR account: ${signer}`);
  return [
    "near contract call-function as-transaction", tx.receiverId, tx.methodName,
    `json-args ${shellQuote(JSON.stringify(tx.args))}`, `prepaid-gas '${tx.gas / TGAS} Tgas'`, `attached-deposit '${tx.deposit} yoctoNEAR'`,
    `sign-as ${signer === null ? "YOUR_ACCOUNT.near" : shellQuote(signer)}`, `network-config ${network}`, "sign-with-keychain send",
  ].join(" ");
}
