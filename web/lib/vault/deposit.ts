import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { navUsdc } from "@/lib/chain/vault";
import { type WalletTx, gasFor } from "@/lib/wallet/calls";
import { vaultNearOk } from "./near";

export type GateReason = "unreadable" | "frozen" | "halted" | "not-ready" | "low-vault-near" | "closed-allowlist";

/** Whether the deposit form may render, with every reason it may not (WEBSITE §3 Deposit step 2–3). */
export function depositGate(s: VaultSnapshot, p: Position | null, unreadable: boolean): { open: boolean; reasons: GateReason[] } {
  if (unreadable) return { open: false, reasons: ["unreadable"] };
  const reasons: GateReason[] = [];
  if (s.frozen) reasons.push("frozen");
  if (s.halted) reasons.push("halted");
  if (!s.setupDone || !s.selftestPassed) reasons.push("not-ready");
  if (!vaultNearOk(s.account, s.policy.nearReserve)) reasons.push("low-vault-near");
  if (p && !s.policy.openDeposits && !p.allowed) reasons.push("closed-allowlist");
  return { open: reasons.length === 0, reasons };
}

/** NEAR the account still needs for these calls: every attached deposit plus gas at the current price. */
export function nearShortfallFor(txs: readonly WalletTx[], nearBalance: bigint, gasPrice: bigint): bigint {
  const need = txs.reduce((sum, t) => sum + t.deposit + t.gas * gasPrice, 0n);
  return need > nearBalance ? need - nearBalance : 0n;
}

/** The numbers shown next to the Deposit button (WEBSITE §3, "Sebelum tombol Deposit"). */
export function depositChecks(amount: bigint, s: VaultSnapshot, p: Position, gasPrice: bigint) {
  const needsRegistration = !p.registered.vault;
  const txs: WalletTx[] = [
    ...(needsRegistration ? [{ receiverId: s.vaultId, methodName: "storage_deposit", args: {}, gas: gasFor("register_vault"), deposit: s.storageMin }] : []),
    { receiverId: s.assets.usdc, methodName: "ft_transfer_call", args: {}, gas: gasFor("deposit"), deposit: 1n },
  ];
  const remainingUserCap = s.policy.perUserCap > p.netDeposit ? s.policy.perUserCap - p.netDeposit : 0n;
  const nav = navUsdc(s.book, s.price, s.assets) ?? s.book.usdc;
  return {
    belowMin: amount < s.policy.minDeposit,
    remainingUserCap,
    overUserCap: amount > remainingUserCap,
    overBalance: amount > p.balances.usdc,
    tvlRemainingEstimate: s.policy.tvlCap > nav ? s.policy.tvlCap - nav : 0n,
    needsRegistration,
    nearShortfall: nearShortfallFor(txs, p.balances.near, gasPrice),
  };
}
