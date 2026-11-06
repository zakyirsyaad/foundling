import type { AccountInfo } from "@/lib/chain/rpc";

/** NEAR protocol storage price: 10^19 yoctoNEAR per byte. */
export const STORAGE_BYTE_COST = 10n ** 19n;

/** The vault's NEAR must cover its storage stake plus `near_reserve`, or it refuses deposits. */
export function vaultNearOk(account: AccountInfo, nearReserve: bigint): boolean {
  return account.amount >= account.storageUsage * STORAGE_BYTE_COST + nearReserve;
}
