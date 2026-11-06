import type { ChainId } from "@/config/deployment";
import type { StoredSwap } from "./store";

export type FlowStep = "connect" | "quote" | "prepare" | "send" | "wait";

export interface FlowState {
  step: FlowStep;
  boundAccount: string | null;
  chain: ChainId | null;
  swap: StoredSwap | null;
  addressShown: boolean;
  problem: string | null;
}

export type FlowEvent =
  | { type: "connected"; account: string }
  | { type: "account-changed"; account: string | null }
  | { type: "quoted"; chain: ChainId }
  | { type: "prepared" }
  | { type: "address-verified"; swap: StoredSwap }
  | { type: "status"; status: string }
  | { type: "problem"; message: string }
  | { type: "reset" };

const STILL_SENDING = new Set(["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "not-found", "unknown"]);

export const initialFlow: FlowState = { step: "connect", boundAccount: null, chain: null, swap: null, addressShown: false, problem: null };

/**
 * The guided cross-chain flow (WEBSITE §3 steps 1–5). It is bound to the account from step 1: an
 * account change before the deposit address shows starts over at the quote; after that, the swap
 * stays with the account it was made for.
 */
export function flowReducer(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case "connected":
      return { ...s, step: s.step === "connect" ? "quote" : s.step, boundAccount: e.account };
    case "account-changed":
      if (s.addressShown || e.account === s.boundAccount) return s;
      return e.account ? { ...initialFlow, step: "quote", boundAccount: e.account } : { ...initialFlow };
    case "quoted":
      return { ...s, step: "prepare", chain: e.chain, problem: null };
    case "prepared":
      return { ...s, step: "send", problem: null };
    case "address-verified":
      return { ...s, step: "send", swap: e.swap, addressShown: true, problem: null };
    case "status":
      // Until funds arrive (a 404 counts as PENDING_DEPOSIT), the address step stays.
      return STILL_SENDING.has(e.status) ? s : { ...s, step: "wait" };
    case "problem":
      return { ...s, problem: e.message };
    case "reset":
      return { ...initialFlow, step: s.boundAccount ? "quote" : "connect", boundAccount: s.boundAccount };
  }
}
