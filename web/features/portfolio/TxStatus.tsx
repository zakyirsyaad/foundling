import { Hash } from "@/components/fm/Hash";
import type { TxState } from "@/lib/wallet/txState";

export function TxStatus({ state }: { state: TxState }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "awaiting-wallet":
      return <p role="status">Waiting for your wallet.</p>;
    case "sent":
      return <p role="status">Sent. {state.hashes.map((h) => <Hash key={h} value={h} label="transaction hash" />)}</p>;
    case "done":
      return <p role="status">Done. {state.hashes.map((h) => <Hash key={h} value={h} label="transaction hash" />)}</p>;
    case "partial":
      return (
        <p role="status">
          Partly done. {state.why === "claim-pending" ? "Part of the payout waits for the running swap; claim it once the swap finishes." : "A transfer failed and moved to claimable; withdraw it below."}
        </p>
      );
    case "cancelled":
      return <p role="status">Cancelled in your wallet. Nothing was sent.</p>;
    case "rejected":
      return (
        <p role="alert">
          {state.sentence} <span className="mono text-[12px] text-muted-foreground">{state.raw}</span>
        </p>
      );
  }
}
