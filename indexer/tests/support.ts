/** Fakes shared by the indexer and API tests: FastNEAR served from a recorded fixture, and a scripted archival RPC. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountTx } from "../src/fastnear";
import type { FastnearTx } from "../src/parse";

export const NEAR_ID = "near-feed";
export const USDC_ID = "usdc-feed";
export const log = () => {};

export function fakeRpc(prices: "ok" | "null" = "ok", tip = 300_000_000n) {
  const calls: string[] = [];
  return {
    calls,
    tip: async () => tip,
    async viewAt<T>(block: bigint, _contract: string, method: string): Promise<T> {
      calls.push(`${method}@${block}`);
      const answers: Record<string, unknown> = {
        book: { usdc: "900", wnear: "5" },
        total_shares: "1000",
        oracle: { account: "pyth.testnet", near_id: NEAR_ID, usdc_id: USDC_ID },
        policy: { price_max_age: 60 },
        list_prices_no_older_than: prices === "ok"
          ? { [NEAR_ID]: { price: "300000000", conf: "1", expo: -8, publish_time: 1 }, [USDC_ID]: { price: "100000000", conf: "1", expo: -8, publish_time: 1 } }
          : { [NEAR_ID]: null, [USDC_ID]: null },
      };
      return answers[method] as T;
    },
  };
}

export function fakeFastnear(list: AccountTx[], txs: FastnearTx[]) {
  const byHash = new Map(txs.map((t) => [t.transaction.hash, t]));
  return {
    async *accountTxs(_vault: string, from: bigint) {
      for (const t of list) if (BigInt(t.tx_block_height) >= from) yield t;
    },
    async transactions(hashes: string[]) {
      return hashes.map((h) => byHash.get(h)!);
    },
  };
}

export function fixture(name: string) {
  const f = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));
  const list: AccountTx[] = f.pages.flatMap((p: { account_txs: AccountTx[] }) => p.account_txs);
  const txs: FastnearTx[] = f.transactions.flatMap((r: { transactions: FastnearTx[] }) => r.transactions);
  return { vault: f.vault as string, expected: f.expected as Record<string, number>, fastnear: fakeFastnear(list, txs) };
}

