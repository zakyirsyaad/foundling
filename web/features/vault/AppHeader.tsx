import Link from "next/link";
import type { ReactNode } from "react";

import type { Network } from "@/config/deployment";
import { AppTabs } from "./AppTabs";

export function AppHeader({ vaultId, network, connect }: { vaultId: string; network: Network; connect?: ReactNode }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-[1120px] items-center gap-3 px-4 text-sm">
        <Link href="/" className="font-semibold tracking-tight">Foundling</Link>
        <span aria-hidden="true" className="text-muted-foreground">/</span>
        <span className="text-muted-foreground">Vault</span>
        <span className="mono truncate text-[12px] max-sm:hidden" title={vaultId}>{vaultId}</span>
        <span className="rounded-sm border px-1.5 py-0.5 text-[12px] font-medium" data-testid="network-badge">{network}</span>
        <div className="ml-auto">{connect}</div>
      </div>
      <AppTabs />
    </header>
  );
}
