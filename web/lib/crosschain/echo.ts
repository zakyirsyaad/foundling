import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";

import type { QuoteRequest } from "./request";

const FIELDS = ["originAsset", "destinationAsset", "amount", "recipient", "refundTo", "swapType", "dry", "depositType", "refundType", "recipientType", "slippageTolerance"] as const;

/** The signed answer must echo the request we sent, field for field; `deadline` is compared to the millisecond. */
export function echoMatches(sent: QuoteRequest, res: OneClickQuoteResponse): { ok: true } | { ok: false; field: keyof QuoteRequest } {
  const echo = (res as { quoteRequest?: Record<string, unknown> }).quoteRequest;
  if (!echo) return { ok: false, field: "deadline" };
  for (const f of FIELDS) if (echo[f] !== sent[f]) return { ok: false, field: f };
  const a = Date.parse(String(echo.deadline));
  if (Number.isNaN(a) || a !== Date.parse(sent.deadline)) return { ok: false, field: "deadline" };
  return { ok: true };
}
