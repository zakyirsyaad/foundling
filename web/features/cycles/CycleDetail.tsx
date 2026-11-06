import { CopyButton } from "@/components/fm/CopyButton";
import { shellQuote } from "@/lib/format/shell";
import { Hash } from "@/components/fm/Hash";
import { Status } from "@/components/fm/Status";
import type { Network } from "@/config/deployment";
import type { CycleRow, ProofResult } from "@/lib/history/client";
import { cycleWord } from "@/lib/cycles/outcome";
import { proofWord, replayWord } from "@/lib/proof/tally";

/** Shell-safe, like TRIGGER_TX: a `<…>` placeholder would be read as a redirect. */
const COMMIT_PLACEHOLDER = "VERIFIER_COMMIT";

/** Pinned to the verifier's commit: a newer verifier can replay a sealed rule differently and fail a good proof. */
function verifyCommand(network: Network, vaultId: string, tx: string | undefined, commit: string | null): string {
  return `git checkout ${commit ?? COMMIT_PLACEHOLDER} && python3 tools/fetch_proof.py --chain ${network} --vault ${shellQuote(vaultId)} --collateral-bin COLLATERAL.bin --out proof.json ${tx ? shellQuote(tx) : "TRIGGER_TX"} && cargo run --manifest-path cli/Cargo.toml -- check proof.json`;
}

function TallyLine({ name, t }: { name: string; t: ProofResult["verifier"] }) {
  return (
    <div>
      <dt className="fm-label">{name}</dt>
      <dd className="mono">{t ? `pass ${t.pass} · skip ${t.skip} · fail ${t.fail} · ${t.state}` : "Not run yet"}</dd>
    </div>
  );
}

export function CycleDetail({ row, proof, decision, revealAfter, chainTime, network, vaultId }: { row: CycleRow; proof: ProofResult | null; decision: string | null; revealAfter: bigint; chainTime: bigint; network: Network; vaultId: string }) {
  const commit = proof?.verifierCommit ?? null;
  const cmd = verifyCommand(network, vaultId, row.txHashes[0], commit);
  // A proof result, when there is one, wins over the list row: null there means "not run".
  const verifier = proof ? proof.verifier : row.verifier;
  const obs = proof ? proof.obsRecheck : row.obsRecheck;
  const limitEvent = row.events.find((e) => e.name === "rejected" || e.name === "executed");
  return (
    <article className="grid gap-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Cycle {row.nonce.toString()}</h1>
        <Status group="cycle" word={cycleWord(row.events)} />
        <Status group="proof" word={proofWord(verifier, obs)} />
      </header>
      <section aria-labelledby="timeline">
        <h2 id="timeline" className="mb-3 text-lg font-semibold">Timeline</h2>
        <ol className="grid gap-1">
          {row.events.map((e, i) => (
            <li key={`${e.name}-${i}`} className="mono text-[13px]">{e.name}{e.code ? ` (${e.code})` : ""}</li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="decision">
        <h2 id="decision" className="mb-3 text-lg font-semibold">Decision</h2>
        <p className="mono text-[13px] break-all">{decision ?? "No decision to verify"}</p>
      </section>
      <section aria-labelledby="limits">
        <h2 id="limits" className="mb-3 text-lg font-semibold">Limit check</h2>
        <p>{limitEvent ? (limitEvent.name === "executed" ? "Every limit held; the trade ran." : `Rejected by the contract: ${limitEvent.code ?? "no code"}.`) : "No limit check in this cycle."}</p>
      </section>
      <section aria-labelledby="txs">
        <h2 id="txs" className="mb-3 text-lg font-semibold">Transactions</h2>
        <ul className="grid gap-1">
          {row.txHashes.map((h) => (
            <li key={h}><Hash value={h} label="transaction hash" /></li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="proof">
        <h2 id="proof" className="mb-3 text-lg font-semibold">Proof</h2>
        <dl className="grid gap-2">
          <TallyLine name="Verifier" t={verifier} />
          <TallyLine name="obs recheck" t={obs} />
          <div>
            <dt className="fm-label">Replay</dt>
            <dd><Status group="proof" word={replayWord(revealAfter, chainTime, proof?.replay ?? "sealed")} /></dd>
          </div>
        </dl>
        <p className="mt-3 text-[13px] text-muted-foreground">Newer verifiers also check the advisor&apos;s archived NEAR AI signature and count a missing one as a skip; the commit in the command decides which checks run. A result shown here is a claim; the command below is the answer.</p>
        {commit ? null : <p className="mt-1 text-[13px] text-muted-foreground">{`Replace ${COMMIT_PLACEHOLDER} with the commit that built this vault's binary.`}</p>}
        <div className="fm-code mt-3">
          <code className="break-all">{cmd}</code>
          <CopyButton text={cmd} label="Copy command" />
        </div>
      </section>
    </article>
  );
}
