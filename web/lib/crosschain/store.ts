import { z } from "zod";

import type { ChainId, Network } from "@/config/deployment";

export interface StoredSwap {
  /** Null once the swap is final: only the static tx record is kept (1Click ToS 4.1(e)). */
  depositAddress: string | null;
  recipient: string;
  chainId: ChainId;
  deadlineMs: number;
  createdAtMs: number;
  final: "SUCCESS" | "REFUNDED" | "FAILED" | null;
  txHashes: string[];
  declaredNotSent: boolean;
}

const swapSchema = z.object({
  depositAddress: z.string().nullable(),
  recipient: z.string(),
  chainId: z.enum(["base", "arb", "eth"]),
  deadlineMs: z.number(),
  createdAtMs: z.number(),
  final: z.enum(["SUCCESS", "REFUNDED", "FAILED"]).nullable(),
  txHashes: z.array(z.string()),
  declaredNotSent: z.boolean(),
});

export function swapKey(network: Network, vaultId: string): string {
  return `foundling.swaps.v1:${network}:${vaultId}`;
}

const id = (s: StoredSwap) => s.depositAddress ?? `final:${s.createdAtMs}:${s.txHashes.join(",")}`;

/**
 * Swaps the browser tracks, one entry per deposit address so two tabs never overwrite each other.
 * The stored address is only ever used to read status, never shown again as somewhere to send.
 * Unresolved swaps are kept past their deadline: a late answer or a stuck transfer must remain
 * queryable for support. Final records keep only their static tx record.
 */
export function createSwapStore(storage: Storage | null, key: string) {
  let memory: StoredSwap[] = [];
  const read = (): StoredSwap[] => {
    try {
      const raw = storage?.getItem(key);
      if (raw == null) return memory;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Entry by entry: one record this build cannot read must not drop the swaps it can.
      return parsed.flatMap((entry) => {
        const one = swapSchema.safeParse(entry);
        return one.success ? [one.data] : [];
      });
    } catch {
      return memory;
    }
  };
  const write = (list: StoredSwap[]) => {
    memory = list;
    try {
      storage?.setItem(key, JSON.stringify(list));
    } catch {
      // Blocked storage: keep the list for this tab only.
    }
  };
  return {
    list: read,
    upsert(s: StoredSwap) {
      const rest = read().filter((x) => id(x) !== id(s));
      write([...rest, s]);
    },
    prune() {
      // Never discard an unresolved swap because time passed. Once it is final, the address is no
      // longer needed to read status, so only the static tx record remains.
      write(read().map((s) => (s.final ? { ...s, depositAddress: null } : s)));
    },
    remove(depositAddress: string) {
      write(read().filter((s) => s.depositAddress !== depositAddress));
    },
    onChange(cb: () => void): () => void {
      const handler = (e: StorageEvent) => {
        if (e.key === key) cb();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}

/** An unresolved swap whose deadline has passed: keep it for status checks, never as a send target. */
export function expiredSwap(s: StoredSwap, nowMs: number): boolean {
  return s.final === null && nowMs >= s.deadlineMs;
}

/** A swap of this account that may still receive funds, so a second quote would risk a second send. */
export function blockingSwap(swaps: readonly StoredSwap[], account: string, nowMs: number): StoredSwap | null {
  return swaps.find((s) => s.recipient === account && s.final === null && nowMs < s.deadlineMs && !s.declaredNotSent) ?? null;
}
