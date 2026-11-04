import { Banner } from "@/components/fm/Banner";
import type { VaultSnapshot } from "@/lib/chain/types";
import { vaultNearOk } from "@/lib/vault/near";

export function VaultBanner({ s, unreadable }: { s: VaultSnapshot | null; unreadable: boolean }) {
  if (unreadable || !s) {
    return (
      <Banner tone="warning" title="Vault not readable">
        {s ? `Showing block #${s.blockHeight}. Deposits are paused here until a fresh read. Exits stay open.` : "No RPC answered. The CLI commands still work."}
      </Banner>
    );
  }
  if (s.halted) return <Banner tone="danger" title="Halted">Trading and new deposits are stopped until the governor clears the halt. Redeem stays open.</Banner>;
  if (s.frozen) return <Banner tone="neutral" title="Frozen">Trading and new deposits are paused. Redeem, claims and cancelling a queued deposit still work. Only the governor can unfreeze.</Banner>;
  if (!s.setupDone || !s.selftestPassed) return <Banner tone="neutral" title="Not ready">Setup or the self-test has not finished, so deposits are closed.</Banner>;
  if (!vaultNearOk(s.account, s.policy.nearReserve)) return <Banner tone="warning" title="Vault NEAR below its reserve">The contract refuses deposits until the vault holds more NEAR.</Banner>;
  return null;
}
