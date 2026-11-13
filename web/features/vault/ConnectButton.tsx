"use client";

import { useState } from "react";

import { truncateMiddle } from "@/components/fm/Hash";
import { useWallet } from "@/lib/wallet/WalletProvider";

export function ConnectButton() {
  const { wallet, account } = useWallet();
  const [busy, setBusy] = useState(false);
  if (account) {
    return (
      <span className="flex items-center gap-2">
        <span className="mono text-[12px]" title={account} data-testid="account">{truncateMiddle(account)}</span>
        <button type="button" className="fm-btn fm-btn--outline" onClick={() => void wallet?.disconnect()}>Disconnect</button>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={!wallet || busy}
      className="fm-btn fm-btn--primary"
      onClick={async () => {
        setBusy(true);
        try {
          await wallet?.connect();
        } catch {
          // Closing the wallet picker is not an error worth showing.
        } finally {
          setBusy(false);
        }
      }}
    >
      Connect wallet
    </button>
  );
}
