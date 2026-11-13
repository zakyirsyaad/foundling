import { Card } from "@/components/fm/Card";
import { Hash } from "@/components/fm/Hash";
import type { Network } from "@/config/deployment";
import { Mark } from "@/features/cycles/Mark";
import type { DecisionFacts, DecisionReason, PublishedDecision, Regime } from "@/lib/cycles/decision";
import { formatUnits, NEAR_DECIMALS } from "@/lib/format/units";

const USDC_DECIMALS = 6;
const WNEAR_SHOWN = 4;

const RULE: Record<Regime, string> = { risk_on: "Risk on: buy", risk_off: "Risk off: sell", undetermined: "Undetermined" };

function actionText(d: PublishedDecision): string {
  if (d.action === "buy_risk") return `Buy wNEAR · ${formatUnits(d.amountIn, USDC_DECIMALS)} USDC in`;
  if (d.action === "sell_risk") return `Sell wNEAR · ${formatUnits(d.amountIn, NEAR_DECIMALS, WNEAR_SHOWN)} wNEAR in`;
  return "None";
}

/** The answer to "why did this cycle end the way it did", in the order the code decides it. */
/** `revealed` is true once the replay has run, which the worker does only after the vault's `reveal`. */
export function WhyCard({ reason, revealed }: { reason: DecisionReason; revealed: boolean }) {
  return (
    <Card id="why" title={reason.title} aside="Read from the published decision">
      <div className="grid gap-5 p-5">
        <p className="text-base font-medium">{reason.lead}</p>
        <ol aria-label="How the decision was reached" className="grid gap-3">
          {reason.steps.map((s) => (
            <li key={s.text} data-mark={s.mark} className="flex items-center gap-3">
              <Mark mark={s.mark} />
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
        <p className="fm-small">
          {reason.managed
            ? "The AI risk manager reads public crypto headlines and the market, and can only lower exposure: it shrinks or holds back a buy, or moves part of the vault to USDC on a severe risk. It cannot start a buy or stop a sell the price rule calls for."
            : "The AI reads public crypto headlines and can only hold back a buy. It cannot start a trade or stop a sell."}{" "}
          {revealed ? (
            <>The thresholds and the prompt are public since the reveal: read them with the vault&apos;s <code className="mono">revealed</code> view, and replay this decision with the command under Proof.</>
          ) : (
            "The thresholds and the prompt stay sealed until reveal; after that, anyone can replay this decision."
          )}
        </p>
      </div>
    </Card>
  );
}

export function DecisionCard({ decision, facts, raw }: { decision: PublishedDecision; facts: DecisionFacts; raw: string }) {
  return (
    <Card id="decision" title="Decision" aside="Signed in the enclave">
      <div className="grid gap-4 p-5">
        <dl className="fm-kv">
          <dt>Action</dt>
          <dd>{actionText(decision)}</dd>
          <dt>Price rule</dt>
          <dd>{RULE[decision.regime]}</dd>
          <dt>{decision.managed ? "NEAR AI risk" : "NEAR AI risk flag"}</dt>
          <dd>{facts.flag}</dd>
          {decision.aiRef?.note ? (
            <>
              <dt>AI reason</dt>
              {/* Cleaned to safe ASCII by the strategy, and rendered as text. */}
              <dd>{decision.aiRef.note}</dd>
            </>
          ) : null}
          {facts.model ? (
            <>
              <dt>Model</dt>
              <dd>{facts.model}</dd>
            </>
          ) : null}
          {decision.aiRef ? (
            <>
              <dt>Signed answer</dt>
              <dd><Hash value={decision.aiRef.chatId} label="NEAR AI chat id" /></dd>
              <dt>Answer hash</dt>
              <dd><Hash value={decision.aiRef.respSigHash} label="answer hash" /></dd>
            </>
          ) : null}
          <dt>Commitment</dt>
          <dd><Hash value={decision.commitment} label="commitment" /></dd>
          <dt>Inputs digest</dt>
          <dd><Hash value={decision.inputsDigest} label="inputs digest" /></dd>
        </dl>
        <details className="fm-small">
          <summary className="cursor-pointer">Decision as published on chain</summary>
          <p className="mono mt-2 text-[12px] break-all">{raw}</p>
        </details>
      </div>
    </Card>
  );
}

/** `obs`: the two public prices the strategy saw (`strategy/src/sources.rs`: Rhea pool 4512 and Kraken's last 20 trades) and their gap. */
export function InputsCard({ facts, network }: { facts: DecisionFacts; network: Network }) {
  return (
    <Card id="inputs" title="Recorded inputs" aside="obs">
      <dl className="fm-kv p-5">
        <dt>Rhea pool 4512</dt>
        <dd className="mono">{`${facts.priceA} USD per NEAR · ${facts.timeA} UTC`}</dd>
        <dt>Kraken, last 20 trades</dt>
        <dd className="mono">{`${facts.priceB} USD per NEAR · ${facts.timeB} UTC`}</dd>
        <dt>Gap</dt>
        <dd className="mono">{facts.gap}</dd>
      </dl>
      {/* The web cannot tell a rehearsal build from its vault id (WEBSITE §3 Bukti, point 6), so testnet says it. */}
      {network === "testnet" ? <p className="fm-small px-5 pb-5">On testnet a rehearsal build reads both prices from its secret, not from the market.</p> : null}
    </Card>
  );
}
