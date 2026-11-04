import { headers } from "next/headers";
import type { ReactNode } from "react";

import { config } from "@/config";
import { AppHeader } from "@/features/vault/AppHeader";
import { ConnectButton } from "@/features/vault/ConnectButton";
import { WalletProvider } from "@/lib/wallet/WalletProvider";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? "";
  return (
    <WalletProvider nonce={nonce}>
      <AppHeader vaultId={config.vaultId} network={config.network} connect={<ConnectButton />} />
      <main className="mx-auto max-w-[1120px] px-4 py-8 text-sm">{children}</main>
    </WalletProvider>
  );
}
