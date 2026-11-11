import { decisionFacts, explainDecision, parseDecision } from "@/lib/cycles/decision";

import { HELD_DECISION as HELD } from "../fixtures/decision";

/** What `AiRef::default()` serializes to when the advisor is silent: `m` is skipped, the strings are empty. */
const SILENT_REF = { chat_id: "", resp_sig_hash: "" };

type Changes = { regime?: string; action?: string; amount_in?: string; ai_flag?: number; ai_conf?: number; ai_risk?: number; ai_ref?: object | null; obs?: object };
function decision(c: Changes) {
  const base = JSON.parse(HELD);
  const obs = { ...base.obs, ...c.obs, ...(c.ai_flag === undefined ? {} : { ai_flag: c.ai_flag }), ...(c.ai_conf === undefined ? {} : { ai_conf: c.ai_conf }), ...(c.ai_risk === undefined ? {} : { ai_risk: c.ai_risk }) };
  const next = { ...base, ...c, obs };
  delete next.ai_flag;
  delete next.ai_conf;
  delete next.ai_risk;
  if (c.ai_ref === null) delete next.ai_ref;
  return parseDecision(JSON.stringify(next))!;
}

describe("parseDecision", () => {
  test("reads a published decision into typed fields", () => {
    const d = parseDecision(HELD)!;
    expect(d.action).toBe("none");
    expect(d.regime).toBe("risk_on");
    expect(d.amountIn).toBe(0n);
    expect(d.obs).toEqual({ aiFlag: 1, aiConf: 70, aiRisk: null, pa: 363561001n, pb: 364506841n, ta: 1794167946, tb: 1794167934 });
    expect(d.aiRef).toEqual({ chatId: "dbf0db6ea9de4058b636bbbbe3254026", model: 0, respSigHash: "7a4fb7cb9cf223a19f770368299525178be9a78f2af7e224b3e0a82151969754", note: null });
    expect(d.commitment).toBe("70502c3606c1e7057162565089f18f2305490724c3e19b51411a6a4516326295");
  });

  test("a silent advisor publishes ai_ref with empty strings and no m (AiRef::default), which reads as no signed answer", () => {
    expect(decision({ ai_flag: 2, ai_ref: SILENT_REF }).aiRef).toBeNull();
  });

  test("a decision without ai_ref at all also reads as no signed answer", () => {
    expect(decision({ ai_flag: 2, ai_ref: null }).aiRef).toBeNull();
  });

  test.each([
    ["nothing published", null],
    ["text that is not JSON", "not json"],
    ["an unknown action", HELD.replace('"action":"none"', '"action":"burn"')],
    ["an unknown regime", HELD.replace('"regime":"risk_on"', '"regime":"panic"')],
    ["a price that is not a decimal string", HELD.replace('"pa":"363561001"', '"pa":363561001')],
    ["no obs", JSON.stringify({ ...JSON.parse(HELD), obs: undefined })],
    ["a price string that is not a U128", HELD.replace('"pa":"363561001"', '"pa":"-1"')],
    ["a source time past any calendar date", HELD.replace('"ta":1794167946', '"ta":9000000000000')],
  ])("returns null for %s", (_, raw) => {
    expect(parseDecision(raw)).toBeNull();
  });
});

describe("explainDecision", () => {
  const marks = (r: ReturnType<typeof explainDecision>) => r.steps.map((s) => s.mark);

  test("a buy the AI tripwire flagged is held", () => {
    const r = explainDecision(parseDecision(HELD)!, "Hold");
    expect(r.title).toBe("Why it held");
    expect(r.lead).toBe("The price rule called for a buy, and the AI tripwire held it back.");
    expect(r.steps.map((s) => s.text)).toEqual(["Price rule: risk on, buy", "AI tripwire: flagged, confidence 70", "Contract: hold, no trade"]);
    expect(marks(r)).toEqual(["done", "stop", "wait"]);
  });

  test("a buy with no valid AI answer is held as well", () => {
    const r = explainDecision(decision({ ai_flag: 2, ai_ref: SILENT_REF }), "Hold");
    expect(r.lead).toBe("The price rule called for a buy, but the AI gave no valid answer, so the buy was held.");
    expect(r.steps[1]).toEqual({ text: "AI tripwire: silent, no valid answer", mark: "stop" });
  });

  test("a clear buy with no room left is held by the limits, not the AI", () => {
    const r = explainDecision(decision({ ai_flag: 0, ai_conf: 10 }), "Hold");
    expect(r.lead).toBe("The price rule called for a buy, but the vault had no room left to buy within its limits.");
    expect(marks(r)).toEqual(["done", "done", "wait"]);
  });

  test("no clear price signal is a hold that the AI plays no part in", () => {
    const r = explainDecision(decision({ regime: "undetermined" }), "Hold");
    expect(r.lead).toBe("The two prices disagreed, or sat between the sealed thresholds.");
    expect(r.steps.map((s) => s.text)).toEqual(["Price rule: undetermined, no signal", "AI tripwire: recorded, nothing to hold back", "Contract: hold, no trade"]);
    expect(marks(r)).toEqual(["wait", "wait", "wait"]);
  });

  test("a flag outside the known values holds every trade", () => {
    const r = explainDecision(decision({ regime: "risk_off", ai_flag: 3 }), "Hold");
    expect(r.lead).toBe("The AI flag was out of range, so every trade was held.");
    expect(r.steps[1]).toEqual({ text: "AI tripwire: unknown flag 3, holds every trade", mark: "stop" });
  });

  test("a clear buy that ran", () => {
    const r = explainDecision(decision({ action: "buy_risk", amount_in: "15000000", ai_flag: 0, ai_conf: 12 }), "Executed");
    expect(r.title).toBe("Why it traded");
    expect(r.lead).toBe("The price rule called for a buy, the AI tripwire was clear, and every limit held.");
    expect(r.steps[1]).toEqual({ text: "AI tripwire: clear, confidence 12", mark: "done" });
    expect(r.steps[2]).toEqual({ text: "Contract: limits held, the trade ran", mark: "done" });
  });

  test("a flag cannot stop a sell", () => {
    const r = explainDecision(decision({ regime: "risk_off", action: "sell_risk", amount_in: "4", ai_flag: 1 }), "Executed");
    expect(r.lead).toBe("The price rule called for a sell. A flag cannot stop a sell, so the trade ran.");
    expect(r.steps[1]).toEqual({ text: "AI tripwire: flagged, does not apply to sells", mark: "wait" });
  });

  test("a clear sell that ran", () => {
    const r = explainDecision(decision({ regime: "risk_off", action: "sell_risk", amount_in: "4", ai_flag: 0 }), "Executed");
    expect(r.lead).toBe("The price rule called for a sell, and every limit held.");
  });

  test("a trade the contract refused names the code", () => {
    const r = explainDecision(decision({ action: "buy_risk", amount_in: "99000000", ai_flag: 0 }), "Rejected", "OVER_CAP");
    expect(r.title).toBe("Why it was refused");
    expect(r.lead).toBe("The strategy asked to buy, and the contract refused it: OVER_CAP.");
    expect(r.steps[2]).toEqual({ text: "Contract: refused, OVER_CAP", mark: "stop" });
  });

  test("a reversed swap says the funds came back", () => {
    const r = explainDecision(decision({ action: "buy_risk", amount_in: "1", ai_flag: 0 }), "Reversed");
    expect(r.lead).toBe("The strategy asked to buy; the swap did not go through and the funds came back.");
    expect(r.steps[2]).toEqual({ text: "Contract: swap reversed", mark: "stop" });
  });

  test("a cycle still in flight says so", () => {
    const r = explainDecision(decision({ action: "buy_risk", amount_in: "1", ai_flag: 0 }), "Running");
    expect(r.title).toBe("How it was decided");
    expect(r.steps[2]).toEqual({ text: "Contract: in progress", mark: "wait" });
  });

  test("a failed or aborted cycle says so in the contract step", () => {
    expect(explainDecision(decision({ action: "buy_risk", amount_in: "1", ai_flag: 0 }), "Aborted").steps[2]).toEqual({ text: "Contract: cycle aborted", mark: "stop" });
    expect(explainDecision(decision({ action: "buy_risk", amount_in: "1", ai_flag: 0 }), "Failed").steps[2]).toEqual({ text: "Contract: cycle failed", mark: "stop" });
  });

  test("an executed cycle whose decision asked for no trade does not invent a sell", () => {
    const r = explainDecision(parseDecision(HELD)!, "Executed");
    expect(r.lead).toBe("The cycle executed, but its published decision asked for no trade.");
  });
});

describe("decisionFacts", () => {
  test("formats prices, their times, the gap and the model", () => {
    expect(decisionFacts(parseDecision(HELD)!)).toEqual({
      priceA: "3.6356",
      priceB: "3.645",
      timeA: "19:59:06",
      timeB: "19:58:54",
      gap: "0.26%",
      flag: "Flagged · confidence 70",
      model: "GLM-5.3 Flash",
    });
  });

  test("a silent advisor has no model and says so", () => {
    const f = decisionFacts(decision({ ai_flag: 2, ai_ref: SILENT_REF }));
    expect(f.flag).toBe("Silent · no valid answer");
    expect(f.model).toBeNull();
  });

  test("a zero second price has no gap to show", () => {
    expect(decisionFacts(decision({ obs: { pb: "0" } })).gap).toBe("–");
  });

  test("a model index outside the list is shown as a number, not a guess", () => {
    expect(decisionFacts(decision({ ai_ref: { chat_id: "a", m: 7, resp_sig_hash: "b" } })).model).toBe("Model 7");
  });
});

/** An AI Risk Manager decision (SPEC §3.2): the advisor answered (flag 0) with a risk score and a reason. */
const NOTE = "Exploit reported on a NEAR DEX.";
const managed = (c: Changes) => decision({ ai_flag: 0, ai_conf: 75, ai_ref: { chat_id: "chat", m: 0, resp_sig_hash: "abc", note: NOTE }, ...c });

describe("AI Risk Manager decisions", () => {
  test("parse reads the risk and the reason", () => {
    const d = managed({ ai_risk: 85 });
    expect(d.obs.aiRisk).toBe(85);
    expect(d.aiRef?.note).toBe(NOTE);
    expect(d.managed).toBe(true);
  });

  test("an old decision has no risk and is not managed", () => {
    const d = parseDecision(HELD)!;
    expect(d.obs.aiRisk).toBeNull();
    expect(d.aiRef?.note).toBeNull();
    expect(d.managed).toBe(false);
  });

  test("a risk outside 0 to 100 is not Decision v1", () => {
    expect(parseDecision(HELD.replace('"ai_flag":1', '"ai_flag":0,"ai_risk":101'))).toBeNull();
  });

  test("a protective sell says the AI moved the vault to USDC", () => {
    const r = explainDecision(managed({ action: "sell_risk", amount_in: "4", ai_risk: 85 }), "Executed");
    expect(r.title).toBe("Why it moved to USDC");
    expect(r.lead).toBe("The AI risk manager rated the risk 85 of 100 with confidence 75 and moved part of the vault to USDC. The price rule alone would not have sold.");
    expect(r.steps).toEqual([
      { text: "Price rule: risk on, buy", mark: "wait" },
      { text: "AI risk manager: risk 85, sold to USDC", mark: "stop" },
      { text: "Contract: limits held, the trade ran", mark: "done" },
    ]);
    expect(r.managed).toBe(true);
  });

  test("a buy at some risk is scaled down", () => {
    const r = explainDecision(managed({ action: "buy_risk", amount_in: "700", ai_risk: 30 }), "Executed");
    expect(r.lead).toBe("The price rule called for a buy, and the AI risk manager rated the risk 30 of 100, so the buy ran at 70% of its sealed size.");
    expect(r.steps[1]).toEqual({ text: "AI risk manager: risk 30, buy scaled to 70%", mark: "done" });
  });

  test("a buy at no risk runs at full size", () => {
    const r = explainDecision(managed({ action: "buy_risk", amount_in: "1000", ai_risk: 0 }), "Executed");
    expect(r.lead).toBe("The price rule called for a buy, and the AI risk manager rated the risk 0 of 100, so the buy ran at full size.");
    expect(r.steps[1]).toEqual({ text: "AI risk manager: risk 0, full size", mark: "done" });
  });

  test("a held buy names the risk without guessing the sealed veto", () => {
    const r = explainDecision(managed({ ai_risk: 60 }), "Hold");
    expect(r.lead).toBe("The price rule called for a buy, and the AI risk manager rated the risk 60 of 100. The buy was held: vetoed, or no room was left within the limits.");
    expect(r.steps[1]).toEqual({ text: "AI risk manager: risk 60, buy held", mark: "stop" });
  });

  test("a price sell is not the AI's doing", () => {
    const r = explainDecision(managed({ regime: "risk_off", action: "sell_risk", amount_in: "4", ai_risk: 20 }), "Executed");
    expect(r.lead).toBe("The price rule called for a sell, and every limit held.");
    expect(r.steps[1]).toEqual({ text: "AI risk manager: risk 20, does not apply to sells", mark: "wait" });
  });

  test("a refused protective sell names the code", () => {
    const r = explainDecision(managed({ action: "sell_risk", amount_in: "4", ai_risk: 90 }), "Rejected", "OVER_CAP");
    expect(r.lead).toBe("The AI risk manager asked to move part of the vault to USDC, and the contract refused it: OVER_CAP.");
  });

  test("the facts show the risk and the confidence", () => {
    expect(decisionFacts(managed({ ai_risk: 85 })).flag).toBe("Risk 85 · confidence 75");
  });
});
