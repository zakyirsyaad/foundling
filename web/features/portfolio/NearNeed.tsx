import { NEAR_DECIMALS, formatUnits } from "@/lib/format/units";
import type { WalletTx } from "@/lib/wallet/calls";
import { nearShortfallFor } from "@/lib/vault/deposit";


/** The exact NEAR an action still needs for its deposits and gas (WEBSITE §3 and §7). Nothing when enough. */
export function NearNeed({ txs, near, gasPrice }: { txs: WalletTx[]; near: bigint; gasPrice: bigint }) {
  const short = nearShortfallFor(txs, near, gasPrice);
  if (short === 0n) return null;
  return <p data-testid="near-need" className="text-[13px]">You need {formatUnits(short, NEAR_DECIMALS, 5)} more NEAR for this. Get NEAR from an exchange or another wallet first.</p>;
}
