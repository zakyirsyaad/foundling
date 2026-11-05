import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTransaction, type FastnearTx } from "../src/parse";

interface Fixture {
  vault: string;
  pages: { account_txs: { transaction_hash: string }[] }[];
  transactions: { transactions: FastnearTx[] }[];
  expected: Record<string, number>;
}

const load = (name: string): Fixture => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));

test.each([
  ["m5", 49],
  ["m10", 16],
  ["m12", 38],
])("the %s vault parses to the event counts recorded through RPC", (name, txCount) => {
  const f = load(name);
  const hashes = new Set(f.pages.flatMap((p) => p.account_txs.map((t) => t.transaction_hash)));
  expect(hashes.size).toBe(txCount);

  const counts: Record<string, number> = {};
  for (const tx of f.transactions.flatMap((r) => r.transactions)) {
    for (const e of parseTransaction(f.vault, tx)) counts[e.name] = (counts[e.name] ?? 0) + 1;
  }
  expect(Object.keys(f.expected).length).toBeGreaterThan(0);
  expect(counts).toEqual(f.expected);
});
