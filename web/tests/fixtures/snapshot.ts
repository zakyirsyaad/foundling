import { readVaultSnapshot } from "@/lib/chain/vault";
import type { RpcClient } from "@/lib/chain/rpc";
import type { VaultSnapshot } from "@/lib/chain/types";
import { vaultViews } from "./vault";

export function fixtureRpc(views: Record<string, unknown> = vaultViews, accessKeys = 0): RpcClient {
  return {
    async view(_c, method, _a, parse) {
      if (!(method in views)) throw new Error(`no fixture for ${method}`);
      return { value: parse(views[method]), blockHeight: 200n };
    },
    async finalBlock() { return { height: 201n, timestampSeconds: 1800000000n }; },
    async viewAccount() { return { value: { amount: 10n ** 25n, storageUsage: 1000n, codeHash: "CodeHash111" }, blockHeight: 200n }; },
    async accessKeyCount() { return { value: accessKeys, blockHeight: 200n }; },
    async gasPrice() { return 100_000_000n; },
  };
}

export async function fixtureSnapshot(overrides: Partial<VaultSnapshot> = {}, accessKeys = 0): Promise<VaultSnapshot> {
  return { ...(await readVaultSnapshot(fixtureRpc(vaultViews, accessKeys), "vault.foundling.near", () => 1_000)), ...overrides };
}
