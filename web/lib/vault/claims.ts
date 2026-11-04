import { z } from "zod";

import type { RpcClient } from "@/lib/chain/rpc";
import type { VaultSnapshot } from "@/lib/chain/types";
import { u128Schema } from "@/lib/chain/types";

export interface ClaimRow {
  nonce: bigint;
  amount: bigint;
  resolved: boolean;
}

/** WEBSITE §3 Redeem step 7: scan the last 16 nonces automatically, the rest on request. */
export const CLAIM_SCAN_DEPTH = 16;

/** Bucket claims for `account`, scanning back from `from`. `next` is where the following page starts. */
export async function findClaims(rpc: RpcClient, s: VaultSnapshot, account: string, from: bigint, depth = CLAIM_SCAN_DEPTH): Promise<{ rows: ClaimRow[]; next: bigint | null }> {
  const n = Math.min(depth, Number(from));
  const nonces = Array.from({ length: Math.max(0, n) }, (_, i) => from - BigInt(i));
  const amounts = await Promise.all(nonces.map((nonce) => rpc.view(s.vaultId, "bucket_claim", { nonce: Number(nonce), account }, (r) => u128Schema.parse(r)).then((v) => v.value)));
  const hits = nonces.map((nonce, i) => ({ nonce, amount: amounts[i]! })).filter((c) => c.amount > 0n);
  const rows = await Promise.all(
    hits.map(async (c) => {
      const bucket = (await rpc.view(s.vaultId, "bucket", { nonce: Number(c.nonce) }, (r) => z.unknown().parse(r))).value;
      return { ...c, resolved: bucket !== null && s.inflight?.nonce !== c.nonce };
    }),
  );
  const last = from - BigInt(n);
  return { rows, next: last >= 1n ? last : null };
}
