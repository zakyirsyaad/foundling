import Link from "next/link";

import { Card } from "@/components/fm/Card";
import { CopyButton } from "@/components/fm/CopyButton";
import { shellQuote } from "@/lib/format/shell";
import { Hash } from "@/components/fm/Hash";
import { Status } from "@/components/fm/Status";
import type { Network } from "@/config/deployment";
import { DecisionCard, InputsCard, WhyCard } from "@/features/cycles/DecisionCards";
import { Mark } from "@/features/cycles/Mark";
import { decisionFacts, explainDecision, parseDecision } from "@/lib/cycles/decision";
import type { CycleRow, ProofResult } from "@/lib/history/client";
import { type CycleWord, cycleWord, eventMark } from "@/lib/cycles/outcome";
import { proofWord, replayWord } from "@/lib/proof/tally";

/** Shell-safe, like TRIGGER_TX: a `<…>` placeholder would be read as a redirect. */
const COMMIT_PLACEHOLDER = "VERIFIER_COMMIT";

/** `fetch_proof.py` needs the verifier built with its `fetch` feature, so the command builds it first. */
const VERIFY_BIN = "cli/target/release/foundling-verify";
/** Regular nodes drop a transaction after about a day; an archival node still has it when a reader runs this later. */
const ARCHIVE_RPC: Record<Network, string> = { mainnet: "https://archival-rpc.mainnet.fastnear.com", testnet: "https://archival-rpc.testnet.fastnear.com" };

/** Pinned to the verifier's commit: a newer verifier can replay a sealed rule differently and fail a good proof. */
function verifyCommand(network: Network, vaultId: string, tx: string | undefined, commit: string | null): string {
  const build = `cargo build --release --locked --features fetch --manifest-path cli/Cargo.toml`;
  const fetch = `python3 tools/fetch_proof.py --chain ${network} --vault ${shellQuote(vaultId)} --collateral-bin ${VERIFY_BIN} --rpc ${ARCHIVE_RPC[network]} --out proof.json ${tx ? shellQuote(tx) : "TRIGGER_TX"}`;
  return `git checkout ${commit ?? COMMIT_PLACEHOLDER} && ${build} && ${fetch} && ${VERIFY_BIN} check proof.json`;
}

/** Everything the decision cards need, or null when nothing was published or it is not Decision v1. */
function decisionView(raw: string | null, word: CycleWord, rejectCode: string | undefined) {
  const parsed = parseDecision(raw);
  if (!parsed || raw === null) return null;
  return { raw, parsed, reason: explainDecision(parsed, word, rejectCode), facts: decisionFacts(parsed) };
}

function TallyLine({ name, t }: { name: string; t: ProofResult["verifier"] }) {
  return (
    <>
      <dt>{name}</dt>
      <dd className="mono">{t ? `pass ${t.pass} · skip ${t.skip} · fail ${t.fail} · ${t.state}` : "Not run yet"}</dd>
    </>
  );
}

export function CycleDetail({ row, proof, decision, revealAfter, chainTime, network, vaultId }: { row: CycleRow; proof: ProofResult | null; decision: string | null; revealAfter: bigint; chainTime: bigint; network: Network; vaultId: string }) {
  // A proof result, when there is one, wins over the list row: null there means "not run".
  const verifier = proof ? proof.verifier : row.verifier;
  const obs = proof ? proof.obsRecheck : row.obsRecheck;
  // The latest limit outcome: a PRICE_UNAVAILABLE rejection is retried, so a later one is what the cycle ended on.
  const limitEvent = [...row.events].reverse().find((e) => e.name === "rejected" || e.name === "executed");
  const word = cycleWord(row.events);
  const view = decisionView(decision, word, limitEvent?.name === "rejected" ? limitEvent.code : undefined);
  return (
    <article className="grid gap-6">
      <nav aria-label="Breadcrumb" className="fm-small">
        <Link href="/app/cycles" className="underline underline-offset-4">Cycles</Link> / <span className="mono">{row.nonce.toString()}</span>
      </nav>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Cycle {row.nonce.toString()}</h1>
        <Status group="cycle" word={word} />
        <Status group="proof" word={proofWord(verifier, obs)} />
        <span className="mono fm-small ml-auto">{row.startedAt.replace("T", " ").slice(0, 19)} UTC</span>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid gap-6">
          {view ? <WhyCard reason={view.reason} revealed={proof?.replay === "pass" || proof?.replay === "fail"} /> : null}
          <Card id="timeline" title="Timeline">
            <ol className="grid gap-3 p-5">
              {row.events.map((e, i) => (
                <li key={`${e.name}-${i}`} data-mark={eventMark(e)} className="flex items-center gap-3">
                  <Mark mark={eventMark(e)} />
                  <span className="mono text-[13px]">{e.name}{e.code ? ` (${e.code})` : ""}</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card id="limits" title="Limit check">
            <p className="p-5">{limitEvent ? (limitEvent.name === "executed" ? "Every limit held; the trade ran." : `Rejected by the contract: ${limitEvent.code ?? "no code"}.`) : "No limit check in this cycle."}</p>
          </Card>
          <Card id="txs" title="Transactions">
            <ul className="grid gap-2 p-5">
              {row.txHashes.map((h) => (
                <li key={h}><Hash value={h} label="transaction hash" /></li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="grid gap-6">
          <ProofCard row={row} proof={proof} verifier={verifier} obs={obs} revealAfter={revealAfter} chainTime={chainTime} network={network} vaultId={vaultId} />
          {view ? (
            <>
              <DecisionCard decision={view.parsed} facts={view.facts} raw={view.raw} />
              <InputsCard facts={view.facts} network={network} />
            </>
          ) : (
            <Card id="decision" title="Decision">
              <p className="mono p-5 text-[13px] break-all">{decision ?? "No decision to verify"}</p>
            </Card>
          )}
        </div>
      </div>
    </article>
  );
}

function ProofCard({ row, proof, verifier, obs, revealAfter, chainTime, network, vaultId }: { row: CycleRow; proof: ProofResult | null; verifier: ProofResult["verifier"]; obs: ProofResult["obsRecheck"]; revealAfter: bigint; chainTime: bigint; network: Network; vaultId: string }) {
  const commit = proof?.verifierCommit ?? null;
  const cmd = verifyCommand(network, vaultId, row.txHashes[0], commit);
  return (
    <Card id="proof" title="Proof">
      <div className="grid gap-4 p-5">
        <dl className="fm-kv">
          <TallyLine name="Verifier" t={verifier} />
          <TallyLine name="obs recheck" t={obs} />
          <dt>Replay</dt>
          <dd><Status group="proof" word={replayWord(revealAfter, chainTime, proof?.replay ?? "sealed")} /></dd>
        </dl>
        <p className="fm-small">Newer verifiers also check the advisor&apos;s archived NEAR AI signature and count a missing one as a skip; the commit in the command decides which checks run. A result shown here is a claim; the command below is the answer. A proof you fetch yourself carries no archived signature, because fetching one needs a NEAR AI key, so a newer verifier counts one skip in your run. The first build takes about five minutes.</p>
        {commit ? null : <p className="fm-small">{`Replace ${COMMIT_PLACEHOLDER} with the commit that built this vault's binary.`}</p>}
        <div className="fm-code fm-code--row fm-code--wrap">
          <pre><code>{cmd}</code></pre>
          <CopyButton text={cmd} label="Copy command" icon />
        </div>
      </div>
    </Card>
  );
}
