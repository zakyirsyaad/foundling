import { Hash } from "@/components/fm/Hash";
import type { TxState } from "@/lib/wallet/txState";

export function TxStatus({ state, onAcknowledge }: { state: TxState; onAcknowledge?: () => void }) {
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
          {state.why === "refunded" ? "The vault refused the deposit and the USDC came back in full." : `Partly done. ${state.why === "claim-pending" ? "Part of the payout waits for the running swap; claim it once the swap finishes." : "A transfer failed and moved to claimable; withdraw it below."}`}
        </p>
      );
    case "interrupted":
      return (
        <div role="alert" className="grid gap-2">
          <p>A request went to your wallet before this page reloaded. Check your wallet&apos;s activity before you sign again.</p>
          {onAcknowledge ? <button type="button" className="justify-self-start rounded-md border border-input px-3 py-1.5" onClick={onAcknowledge}>I checked my wallet; nothing was sent</button> : null}
        </div>
      );
    case "unknown":
      return (
        <div role="alert" className="grid gap-2">
          <p>The wallet did not confirm whether this transaction was sent. Check your wallet&apos;s activity before signing again. <span className="mono text-[12px] text-muted-foreground">{state.raw}</span></p>
          {onAcknowledge ? <button type="button" className="justify-self-start rounded-md border border-input px-3 py-1.5" onClick={onAcknowledge}>I checked my wallet; nothing was sent</button> : null}
        </div>
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
