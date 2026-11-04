import type { Network } from "@/config/deployment";
import type { WalletTx } from "./calls";

const TGAS = 10n ** 12n;

/** The near-cli command that does the same as a wallet call, so no action depends on this website. */
export function cliCommand(tx: WalletTx, signer: string | null, network: Network): string {
  const args = JSON.stringify(tx.args).replaceAll("'", "'\\''");
  return [
    "near contract call-function as-transaction", tx.receiverId, tx.methodName,
    `json-args '${args}'`, `prepaid-gas '${tx.gas / TGAS} Tgas'`, `attached-deposit '${tx.deposit} yoctoNEAR'`,
    `sign-as ${signer ?? "<your-account.near>"}`, `network-config ${network}`, "sign-with-keychain send",
  ].join(" ");
}
