/**
 * Contract test against the real 1Click API (WEBSITE §8): dry quotes only, no funds move.
 * Manual and before a release, never in CI.
 *
 *   npm run -w web oneclick:contract                 every chain in mainnet.json
 *   npm run -w web oneclick:contract -- --chain base --record tests/fixtures/oneclick/quote-dry.json
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import mainnet from "@/config/networks/mainnet.json";
import type { OriginChain } from "@/config/deployment";
import { createOneClick } from "@/lib/crosschain/client";
import { echoMatches } from "@/lib/crosschain/echo";
import { createRequestBuilder } from "@/lib/crosschain/request";
import { verifyQuote } from "@/lib/crosschain/signature";

/** An existing account and a checksummed EIP-55 example address; 1Click rejects unknown recipients. */
const RECIPIENT = "intents.near";
const REFUND_TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ONE_USDC = 1_000_000n;

async function main() {
  const { values } = parseArgs({ options: { chain: { type: "string" }, record: { type: "string" } } });
  const client = createOneClick(mainnet.oneClick.baseUrl);
  const tokens = (await client.tokens()) as { assetId: string }[];
  const chains = (mainnet.oneClick.chains as OriginChain[]).filter((c) => !values.chain || c.id === values.chain);
  const build = createRequestBuilder();
  let failed = 0;
  for (const chain of chains) {
    const req = build({ chain, amount: ONE_USDC, recipient: RECIPIENT, refundTo: REFUND_TO, dry: true, destinationAsset: `nep141:${mainnet.usdc}` });
    const res = await client.quote(req);
    const checks = {
      "origin asset listed": tokens.some((t) => t.assetId === chain.originAsset),
      "signature verifies with the pinned key": verifyQuote(res, mainnet.oneClick.quotePublicKey),
      "request echoed": echoMatches(req, res).ok,
    };
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`${ok ? "PASS" : "FAIL"} ${chain.id}: ${name}`);
      if (!ok) failed++;
    }
    if (values.record && chain.id === values.chain) fs.writeFileSync(values.record, `${JSON.stringify(res, null, 2)}\n`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
