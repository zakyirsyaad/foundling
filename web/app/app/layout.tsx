import type { ReactNode } from "react";

import { config } from "@/config";
import { AppHeader } from "@/features/vault/AppHeader";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppHeader vaultId={config.vaultId} network={config.network} />
      <main className="mx-auto max-w-[1120px] px-4 py-8 text-sm">{children}</main>
    </>
  );
}
