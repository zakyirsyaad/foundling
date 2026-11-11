import { z } from "zod";

import type { CycleWord, EventMark } from "@/lib/cycles/outcome";
import { formatUnits, parseU128 } from "@/lib/format/units";

/**
 * Decision v1 as the vault publishes it (`published_decision`, SPEC §3 "Decision v1").
 * Only the fields the cycle page explains are read; anything else in the JSON is ignored.
 */
const U128 = z.string().transform((s, ctx) => {
  try {
    return parseU128(s);
  } catch {
    ctx.addIssue({ code: "custom", message: "not a U128 string" });
    return z.NEVER;
  }
});
/** Unix seconds up to the last second of year 9999, so `Date#toISOString` can always format them. */
const MAX_UNIX_SECONDS = 253_402_300_799;
const SECONDS = z.number().int().nonnegative().max(MAX_UNIX_SECONDS);
/** The AI Risk Manager's 0–100 scale (SPEC §3.2). */
const PERCENT = z.number().int().min(0).max(100);
/** `strategy/src/advisor.rs` cuts the reason at 120 characters; anything longer did not come from it. */
const MAX_NOTE_CHARS = 120;

const DecisionV1 = z.object({
  action: z.enum(["none", "buy_risk", "sell_risk"]),
  regime: z.enum(["risk_on", "risk_off", "undetermined"]),
  amount_in: U128,
  commitment: z.string(),
  inputs_digest: z.string(),
  obs: z.object({ ai_flag: z.number().int().nonnegative(), ai_conf: z.number().int().nonnegative(), ai_risk: PERCENT.optional(), pa: U128, pb: U128, ta: SECONDS, tb: SECONDS }),
  ai_ref: z.object({ chat_id: z.string(), m: z.number().int().nonnegative().optional(), resp_sig_hash: z.string(), note: z.string().max(MAX_NOTE_CHARS).optional() }).optional(),
});

export type Action = z.infer<typeof DecisionV1>["action"];
export type Regime = z.infer<typeof DecisionV1>["regime"];

export interface PublishedDecision {
  action: Action;
  regime: Regime;
  amountIn: bigint;
  commitment: string;
  inputsDigest: string;
  obs: { aiFlag: number; aiConf: number; aiRisk: number | null; pa: bigint; pb: bigint; ta: number; tb: number };
  aiRef: { chatId: string; model: number | null; respSigHash: string; note: string | null } | null;
  /** Made under the AI Risk Manager: the advisor answered with a risk score. Older vaults ran the tripwire. */
  managed: boolean;
}

/** The parsed decision, or null when nothing was published or the text is not Decision v1. */
export function parseDecision(raw: string | null): PublishedDecision | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DecisionV1.safeParse(json);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    action: d.action,
    regime: d.regime,
    amountIn: d.amount_in,
    commitment: d.commitment,
    inputsDigest: d.inputs_digest,
    obs: { aiFlag: d.obs.ai_flag, aiConf: d.obs.ai_conf, aiRisk: d.obs.ai_risk ?? null, pa: d.obs.pa, pb: d.obs.pb, ta: d.obs.ta, tb: d.obs.tb },
    // A silent advisor still publishes `ai_ref`, as `AiRef::default()`: empty strings and no `m`.
    aiRef: d.ai_ref && d.ai_ref.chat_id !== "" ? { chatId: d.ai_ref.chat_id, model: d.ai_ref.m ?? null, respSigHash: d.ai_ref.resp_sig_hash, note: d.ai_ref.note ?? null } : null,
    managed: d.obs.ai_risk !== undefined && d.obs.ai_flag === AI_CLEAR,
  };
}

/** `ai_flag` values from `strategy/src/lib.rs`: clear, flagged (holds a buy), silent (holds a buy). Higher holds everything. */
const AI_CLEAR = 0;
const AI_FLAGGED = 1;
const AI_SILENT = 2;

/** The strategy's model list, `MODELS` in `strategy/src/advisor.rs`, by `ai_ref.m`. */
const MODELS = ["GLM-5.3 Flash", "Qwen3.8-27B"] as const;

export interface DecisionStep { text: string; mark: EventMark }
export interface DecisionReason { title: string; lead: string; steps: [DecisionStep, DecisionStep, DecisionStep]; managed: boolean }

const SIDE: Record<Action, "buy" | "sell" | null> = { none: null, buy_risk: "buy", sell_risk: "sell" };

function ruleStep(regime: Regime): DecisionStep {
  if (regime === "risk_on") return { text: "Price rule: risk on, buy", mark: "done" };
  if (regime === "risk_off") return { text: "Price rule: risk off, sell", mark: "done" };
  return { text: "Price rule: undetermined, no signal", mark: "wait" };
}

/** The AI can hold back a buy only; a flag past `AI_SILENT` holds everything, as `regime_of` does. */
function aiStep(regime: Regime, flag: number, conf: number): DecisionStep {
  if (flag > AI_SILENT) return { text: `AI tripwire: unknown flag ${flag}, holds every trade`, mark: "stop" };
  if (regime === "undetermined") return { text: "AI tripwire: recorded, nothing to hold back", mark: "wait" };
  if (flag === AI_CLEAR) return { text: `AI tripwire: clear, confidence ${conf}`, mark: "done" };
  if (regime === "risk_off") return { text: `AI tripwire: ${flag === AI_FLAGGED ? "flagged" : "silent"}, does not apply to sells`, mark: "wait" };
  return flag === AI_FLAGGED
    ? { text: `AI tripwire: flagged, confidence ${conf}`, mark: "stop" }
    : { text: "AI tripwire: silent, no valid answer", mark: "stop" };
}

function contractStep(word: CycleWord, code: string | undefined): DecisionStep {
  switch (word) {
    case "Hold":
      return { text: "Contract: hold, no trade", mark: "wait" };
    case "Executed":
      return { text: "Contract: limits held, the trade ran", mark: "done" };
    case "Rejected":
      return { text: `Contract: refused, ${code ?? "no code"}`, mark: "stop" };
    case "Reversed":
      return { text: "Contract: swap reversed", mark: "stop" };
    case "Failed":
    case "Aborted":
      return { text: `Contract: cycle ${word.toLowerCase()}`, mark: "stop" };
    default:
      return { text: "Contract: in progress", mark: "wait" };
  }
}

function holdLead(d: PublishedDecision): string {
  const { regime } = d;
  const flag = d.obs.aiFlag;
  if (flag > AI_SILENT) return "The AI flag was out of range, so every trade was held.";
  if (regime === "undetermined") return "The two prices disagreed, or sat between the sealed thresholds.";
  if (regime === "risk_off") return "The price rule called for a sell, but there was nothing to sell within the limits.";
  if (flag === AI_FLAGGED) return "The price rule called for a buy, and the AI tripwire held it back.";
  if (flag === AI_SILENT) return "The price rule called for a buy, but the AI gave no valid answer, so the buy was held.";
  return "The price rule called for a buy, but the vault had no room left to buy within its limits.";
}

function lead(d: PublishedDecision, word: CycleWord, code: string | undefined): string {
  const side = SIDE[d.action] ?? "trade";
  switch (word) {
    case "Hold":
      return holdLead(d);
    case "Executed":
      if (side === "buy") return "The price rule called for a buy, the AI tripwire was clear, and every limit held.";
      if (side === "sell") {
        return d.obs.aiFlag === AI_CLEAR
          ? "The price rule called for a sell, and every limit held."
          : "The price rule called for a sell. A flag cannot stop a sell, so the trade ran.";
      }
      return "The cycle executed, but its published decision asked for no trade.";
    case "Rejected":
      return `The strategy asked to ${side}, and the contract refused it: ${code ?? "no code"}.`;
    case "Reversed":
      return `The strategy asked to ${side}; the swap did not go through and the funds came back.`;
    default:
      return `The strategy asked to ${side}; the cycle is ${word.toLowerCase()}.`;
  }
}

const TITLE: Partial<Record<CycleWord, string>> = { Hold: "Why it held", Executed: "Why it traded", Rejected: "Why it was refused" };

/** A sell the price rule did not call for: only the AI Risk Manager's protective sell makes one. */
function isProtectiveSell(d: PublishedDecision): boolean {
  return d.managed && d.action === "sell_risk" && d.regime !== "risk_off";
}

/** `decide_managed` in `strategy/src/lib.rs`. The sealed veto and exit thresholds are unknown until reveal, so a held buy is not attributed to one. */
function managedAiStep(d: PublishedDecision, risk: number): DecisionStep {
  if (isProtectiveSell(d)) return { text: `AI risk manager: risk ${risk}, sold to USDC`, mark: "stop" };
  if (d.regime === "risk_off") return { text: `AI risk manager: risk ${risk}, does not apply to sells`, mark: "wait" };
  if (d.regime === "undetermined") return { text: `AI risk manager: risk ${risk}, nothing to act on`, mark: "wait" };
  if (d.action === "buy_risk") return risk === 0 ? { text: "AI risk manager: risk 0, full size", mark: "done" } : { text: `AI risk manager: risk ${risk}, buy scaled to ${100 - risk}%`, mark: "done" };
  return { text: `AI risk manager: risk ${risk}, buy held`, mark: "stop" };
}

function managedLead(d: PublishedDecision, risk: number, word: CycleWord, code: string | undefined): string | null {
  if (isProtectiveSell(d)) {
    if (word === "Executed") return `The AI risk manager rated the risk ${risk} of 100 with confidence ${d.obs.aiConf} and moved part of the vault to USDC. The price rule alone would not have sold.`;
    if (word === "Rejected") return `The AI risk manager asked to move part of the vault to USDC, and the contract refused it: ${code ?? "no code"}.`;
    return null;
  }
  if (d.regime !== "risk_on") return null;
  const rated = `The price rule called for a buy, and the AI risk manager rated the risk ${risk} of 100`;
  if (word === "Executed" && d.action === "buy_risk") return risk === 0 ? `${rated}, so the buy ran at full size.` : `${rated}, so the buy ran at ${100 - risk}% of its sealed size.`;
  if (word === "Hold") return `${rated}. The buy was held: vetoed, or no room was left within the limits.`;
  return null;
}

/** Three steps read from the decision, in the order the code runs them: `regime_of`, the AI, the contract. */
export function explainDecision(d: PublishedDecision, word: CycleWord, code?: string): DecisionReason {
  const risk = d.managed ? d.obs.aiRisk : null;
  const rule = ruleStep(d.regime);
  return {
    title: risk !== null && isProtectiveSell(d) && word === "Executed" ? "Why it moved to USDC" : (TITLE[word] ?? "How it was decided"),
    lead: (risk !== null ? managedLead(d, risk, word, code) : null) ?? lead(d, word, code),
    // A protective sell is not what the price rule asked for, so the rule step is not marked done.
    steps: [risk !== null && isProtectiveSell(d) ? { ...rule, mark: "wait" } : rule, risk !== null ? managedAiStep(d, risk) : aiStep(d.regime, d.obs.aiFlag, d.obs.aiConf), contractStep(word, code)],
    managed: d.managed,
  };
}

const PRICE_DECIMALS = 8;
const PRICE_SHOWN = 4;
const HUNDREDTHS_OF_A_PERCENT = 10_000n;

function utcTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(11, 19);
}

/** |pa − pb| as a share of pb, rounded half up to two decimals of a percent. */
function gapPercent(pa: bigint, pb: bigint): string {
  if (pb === 0n) return "–";
  const diff = pa > pb ? pa - pb : pb - pa;
  const hundredths = (diff * HUNDREDTHS_OF_A_PERCENT * 2n + pb) / (2n * pb);
  return `${formatUnits(hundredths, 2)}%`;
}

function flagText(flag: number, conf: number, risk: number | null): string {
  if (flag === AI_CLEAR && risk !== null) return `Risk ${risk} · confidence ${conf}`;
  if (flag === AI_CLEAR) return `Clear · confidence ${conf}`;
  if (flag === AI_FLAGGED) return `Flagged · confidence ${conf}`;
  if (flag === AI_SILENT) return "Silent · no valid answer";
  return `Unknown flag ${flag}`;
}

export interface DecisionFacts { priceA: string; priceB: string; timeA: string; timeB: string; gap: string; flag: string; model: string | null }

/** The recorded inputs, formatted for the page: two prices (8 decimals on chain), their UTC times, the gap, the tripwire. */
export function decisionFacts(d: PublishedDecision): DecisionFacts {
  const m = d.aiRef?.model ?? null;
  return {
    priceA: formatUnits(d.obs.pa, PRICE_DECIMALS, PRICE_SHOWN),
    priceB: formatUnits(d.obs.pb, PRICE_DECIMALS, PRICE_SHOWN),
    timeA: utcTime(d.obs.ta),
    timeB: utcTime(d.obs.tb),
    gap: gapPercent(d.obs.pa, d.obs.pb),
    flag: flagText(d.obs.aiFlag, d.obs.aiConf, d.obs.aiRisk),
    model: m === null ? null : (MODELS[m] ?? `Model ${m}`),
  };
}
