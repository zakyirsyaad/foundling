/**
 * Records one vault's FastNEAR history as a parser fixture (run once, public data, no keys):
 *   npx -w indexer tsx scripts/record-fixture.ts --network testnet --vault <id> --out fixtures/m12.json
 * `expected` is built along a separate path: every tx is read again through archival RPC
 * `EXPERIMENTAL_tx_status` and foundling logs are counted with a plain regex, so the parser
 * is checked against data it never touched.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const HOSTS = {
  testnet: { fastnear: "https://tx.test.fastnear.com", rpc: "https://archival-rpc.testnet.fastnear.com" },
  mainnet: { fastnear: "https://tx.main.fastnear.com", rpc: "https://archival-rpc.mainnet.fastnear.com" },
} as const;
const BATCH = 20;
const EVENT_RE = /^EVENT_JSON:\{"standard":"foundling","version":"[^"]+","event":"([a-z_]+)"/;

const { values } = parseArgs({ options: { network: { type: "string" }, vault: { type: "string" }, out: { type: "string" } } });
const network = values.network as keyof typeof HOSTS;
if (!HOSTS[network] || !values.vault || !values.out) throw new Error("usage: --network testnet|mainnet --vault <id> --out <file>");
const vault = values.vault;
const hosts = HOSTS[network];

async function post(url: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if (res.status !== 429 || attempt >= 4) throw new Error(`${url} answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const pages: any[] = [];
let resume: string | undefined;
do {
  const page = await post(`${hosts.fastnear}/v0/account`, { account_id: vault, is_receiver: true, desc: false, ...(resume ? { resume_token: resume } : {}) });
  pages.push(page);
  resume = page.resume_token ?? undefined;
} while (resume);

const hashes = [...new Set(pages.flatMap((p) => p.account_txs.map((t: any) => t.transaction_hash as string)))];
const transactions: any[] = [];
for (let i = 0; i < hashes.length; i += BATCH) transactions.push(await post(`${hosts.fastnear}/v0/transactions`, { tx_hashes: hashes.slice(i, i + BATCH) }));

const signerOf = new Map<string, string>(transactions.flatMap((r) => r.transactions.map((t: any) => [t.transaction.hash, t.transaction.signer_id])));
const expected: Record<string, number> = {};
for (const hash of hashes) {
  const sender = signerOf.get(hash);
  if (!sender) throw new Error(`FastNEAR returned no transaction for ${hash}`);
  const { result, error } = await post(hosts.rpc, { jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } });
  if (error) throw new Error(`RPC ${hash}: ${JSON.stringify(error)}`);
  for (const ro of result.receipts_outcome) {
    const ok = "SuccessValue" in ro.outcome.status || "SuccessReceiptId" in ro.outcome.status;
    if (ro.outcome.executor_id !== vault || !ok) continue;
    for (const log of ro.outcome.logs as string[]) {
      const m = EVENT_RE.exec(log);
      if (m) expected[m[1]!] = (expected[m[1]!] ?? 0) + 1;
    }
  }
}

writeFileSync(values.out, `${JSON.stringify({ network, vault, recorded_at: new Date().toISOString(), pages, transactions, expected }, null, 1)}\n`);
console.log(`${vault}: ${hashes.length} txs, events ${JSON.stringify(expected)}`);
