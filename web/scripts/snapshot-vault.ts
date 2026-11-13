/**
 * Writes a labelled snapshot of a vault for the landing and /proof before the final vault exists.
 * Reads public views only; no key is read or needed.
 *
 *   npm run -w web snapshot -- --network testnet --vault vault.fdl-m12-0d1276.testnet --out fixtures/m12.json
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import { ContractViewError, type RpcClient, createRpcClient } from "@/lib/chain/rpc";
import { serializeSnapshot } from "@/lib/chain/serialize";
import { readVaultSnapshot } from "@/lib/chain/vault";

const RPC = {
  mainnet: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
  testnet: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
} as const;

/** Rehearsal vaults older than PR #29 have no storage registration; read their bounds as zero. */
function tolerateLegacy(rpc: RpcClient): RpcClient {
  return {
    ...rpc,
    async view(contract, method, args, parse) {
      try {
        return await rpc.view(contract, method, args, parse);
      } catch (err) {
        const missing = err instanceof ContractViewError && err.contractMessage.includes("MethodNotFound");
        if (missing && method === "storage_balance_bounds") return { value: parse({ min: "0", max: null }), blockHeight: 0n };
        throw err;
      }
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { network: { type: "string" }, vault: { type: "string" }, out: { type: "string" } } });
  const network = values.network === "mainnet" ? "mainnet" : values.network === "testnet" ? "testnet" : null;
  if (!network || !values.vault || !values.out) throw new Error("usage: --network mainnet|testnet --vault <account> --out <file>");
  const rpc = tolerateLegacy(createRpcClient(RPC[network], { budget: 60 }));
  const snapshot = await readVaultSnapshot(rpc, values.vault);
  fs.writeFileSync(values.out, `${serializeSnapshot(snapshot)}\n`);
  console.log(`wrote ${values.out}: block #${snapshot.blockHeight}, ${snapshot.accessKeys} access keys`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
