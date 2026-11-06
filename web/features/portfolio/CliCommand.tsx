import { CopyButton } from "@/components/fm/CopyButton";
import type { Network } from "@/config/deployment";
import type { WalletTx } from "@/lib/wallet/calls";
import { cliCommand } from "@/lib/wallet/cli";

/** The same action without this website. */
export function CliCommand({ tx, signer, network }: { tx: WalletTx; signer: string | null; network: Network }) {
  const cmd = cliCommand(tx, signer, network);
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted-foreground">CLI command</summary>
      <div className="fm-code mt-2">
        <code className="break-all">{cmd}</code>
        <CopyButton text={cmd} label="Copy command" />
      </div>
    </details>
  );
}
