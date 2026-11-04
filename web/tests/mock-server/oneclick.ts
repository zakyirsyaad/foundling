import type http from "node:http";

import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { base58 } from "@scure/base";
import nacl from "tweetnacl";

import { type Scenario, send } from "./state";

/** A fixed test key: the mainnet test build pins its public half through NEXT_PUBLIC_ONECLICK_KEY. */
const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
export const TEST_ONECLICK_KEY = `ed25519:${base58.encode(keys.publicKey)}`;

const TOKENS = [
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", blockchain: "arb", symbol: "USDC", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", blockchain: "eth", symbol: "USDC", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
];

let addresses = 0;

function sign(resp: Record<string, unknown>): string {
  // A Uint8Array of the current global: tweetnacl checks instanceof against it, and jsdom swaps it.
  const msg = new Uint8Array(Buffer.from(quoteHash(resp as never), "utf8"));
  return `ed25519:${base58.encode(nacl.sign.detached(msg, keys.secretKey))}`;
}

/** A signed quote as the mock 1Click returns it; exported for unit tests of the card. */
export function quote(s: Pick<Scenario, "extra">, req: Record<string, unknown>): Record<string, unknown> {
  const amount = BigInt(String(req.amount));
  const echo = s.extra.badEcho ? { ...req, recipient: "attacker.near" } : req;
  const resp: Record<string, unknown> = {
    timestamp: new Date(Date.now() + Number(s.extra.clockSkewMs ?? 0)).toISOString(),
    quoteRequest: echo,
    quote: {
      ...(req.dry ? {} : { depositAddress: `0xDep${String(++addresses).padStart(38, "0")}` }),
      amountIn: amount.toString(), amountInFormatted: "", amountInUsd: "",
      minAmountIn: ((amount * 99n) / 100n).toString(),
      amountOut: (amount - 200n).toString(), amountOutFormatted: "", amountOutUsd: "",
      minAmountOut: ((amount * 98n) / 100n).toString(),
      deadline: req.deadline, timeWhenInactive: req.deadline, timeEstimate: 30, refundFee: "2400", withdrawFee: "0",
    },
  };
  resp.signature = sign(resp);
  if (s.extra.badSignature) resp.signature = sign({ ...resp, timestamp: "1970-01-01T00:00:00.000Z" });
  return resp;
}

export function handleOneClick(res: http.ServerResponse, s: Scenario, url: URL, body: string): void {
  if (s.oneClickDown) return send(res, 503, { message: "down" });
  const path = url.pathname.replace(/^\/1click/, "");
  if (path === "/v0/tokens") return send(res, 200, TOKENS);
  if (path === "/v0/quote") return send(res, 201, quote(s, JSON.parse(body)));
  if (path === "/v0/deposit/submit") return send(res, 200, { ok: true });
  if (path === "/v0/status") {
    const st = s.extra.swapStatus as { status: string; swapDetails?: unknown } | undefined;
    if (!st) return send(res, 404, { message: "not found" });
    return send(res, 200, { status: st.status, swapDetails: st.swapDetails ?? {} });
  }
  return send(res, 404, { message: "not found" });
}
