import { z } from "zod";

import type { RpcClient } from "@/lib/chain/rpc";

/** `DECISIONS_KEPT` in cycle.rs: the contract keeps only the last 64 published decisions. */
export const DECISIONS_KEPT = 64;
const DEFAULT_COUNT = 16;

export interface PartialCycle {
  nonce: bigint;
  decision: string | null;
}

/** When the API is down, list the latest cycles from `published_decision`. Always partial. */
export async function fallbackCycles(rpc: RpcClient, vaultId: string, lastNonce: bigint, count = DEFAULT_COUNT): Promise<{ rows: PartialCycle[]; partial: true }> {
  const n = Math.min(count, DECISIONS_KEPT, Number(lastNonce));
  const nonces = Array.from({ length: Math.max(0, n) }, (_, i) => lastNonce - BigInt(i));
  const rows = await Promise.all(
    nonces.map(async (nonce) => ({
      nonce,
      decision: (await rpc.view(vaultId, "published_decision", { nonce: Number(nonce) }, (r) => z.string().nullable().parse(r))).value,
    })),
  );
  return { rows, partial: true };
}
