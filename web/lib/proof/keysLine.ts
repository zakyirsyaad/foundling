import { truncateMiddle } from "@/components/fm/Hash";
import type { Network } from "@/config/deployment";
import type { SnapshotSource } from "./local";

export const UNREADABLE_LINE = "Vault not readable right now. Check it yourself with the command below.";

/** The one server-rendered verifier line under the hero video. */
export function keysLine(src: SnapshotSource | null, network: Network): string {
  if (!src) return UNREADABLE_LINE;
  const s = src.snapshot;
  const keys = `${s.accessKeys} access key${s.accessKeys === 1 ? "" : "s"}`;
  const block = `as of block #${s.blockHeight}`;
  if (src.kind === "sample") return `Testnet rehearsal (m12) · ${truncateMiddle(s.vaultId)} · ${keys} · ${block}`;
  return `${network} · ${s.vaultId} · ${keys} · ${block}`;
}
