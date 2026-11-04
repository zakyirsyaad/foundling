import type { OriginChain } from "@/config/deployment";

/** The quote request 1Click requires; every field is mandatory (WEBSITE §3 cross-chain step 2). */
export interface QuoteRequest {
  dry: boolean;
  swapType: "FLEX_INPUT";
  slippageTolerance: 100;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface QuoteInput {
  chain: OriginChain;
  amount: bigint;
  recipient: string;
  refundTo: string;
  dry: boolean;
  destinationAsset: string;
}

/** Each request gets its own deadline (a later millisecond if needed), so an old signed quote cannot be replayed. */
export function createRequestBuilder(now: () => number = Date.now) {
  let last = 0;
  return (i: QuoteInput): QuoteRequest => {
    const at = Math.max(now() + i.chain.deadlineMs, last + 1);
    last = at;
    return {
      dry: i.dry, swapType: "FLEX_INPUT", slippageTolerance: 100, originAsset: i.chain.originAsset, depositType: "ORIGIN_CHAIN",
      destinationAsset: i.destinationAsset, amount: i.amount.toString(), refundTo: i.refundTo, refundType: "ORIGIN_CHAIN",
      recipient: i.recipient, recipientType: "DESTINATION_CHAIN", deadline: new Date(at).toISOString(),
    };
  };
}
