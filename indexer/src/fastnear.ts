/** FastNEAR transaction API: the vault's tx list (`/v0/account`) and full receipts (`/v0/transactions`). */
import { z } from "zod";
import type { FastnearTx } from "./parse";

export interface AccountTx { transaction_hash: string; tx_block_height: number }

const TX_BATCH = 20;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const TOO_MANY_REQUESTS = 429;
/** Undici's own default is five minutes; a stalled answer must not hold an index round that long. */
const TIMEOUT_MS = 20_000;

const accountPageSchema = z.object({
  account_txs: z.array(z.object({ transaction_hash: z.string(), tx_block_height: z.number() }).passthrough()),
  resume_token: z.string().nullish(),
});
const transactionsSchema = z.object({ transactions: z.array(z.unknown()) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFastnear(base: string, f: typeof fetch = fetch, apiKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };

  async function post(path: string, body: object): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res.json();
      const delay = RETRY_DELAYS_MS[attempt];
      if (res.status !== TOO_MANY_REQUESTS || delay === undefined) throw new Error(`FastNEAR ${path} answered HTTP ${res.status}`);
      await sleep(delay);
    }
  }

  return {
    async *accountTxs(vaultId: string, fromHeight: bigint): AsyncGenerator<AccountTx> {
      let resume: string | undefined;
      do {
        const body = { account_id: vaultId, is_receiver: true, desc: false, from_tx_block_height: Number(fromHeight), ...(resume ? { resume_token: resume } : {}) };
        const page = accountPageSchema.parse(await post("/v0/account", body));
        for (const t of page.account_txs) yield { transaction_hash: t.transaction_hash, tx_block_height: t.tx_block_height };
        resume = page.resume_token ?? undefined;
      } while (resume);
    },

    /** Raw entries; `parseTransaction` validates each one. */
    async transactions(hashes: string[]): Promise<FastnearTx[]> {
      const out: FastnearTx[] = [];
      for (let i = 0; i < hashes.length; i += TX_BATCH) {
        const res = transactionsSchema.parse(await post("/v0/transactions", { tx_hashes: hashes.slice(i, i + TX_BATCH) }));
        out.push(...(res.transactions as FastnearTx[]));
      }
      return out;
    },
  };
}

export type Fastnear = ReturnType<typeof createFastnear>;
