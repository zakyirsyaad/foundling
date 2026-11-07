import Link from "next/link";

import { CopyButton } from "@/components/fm/CopyButton";
import { truncateMiddle } from "@/components/fm/Hash";
import { Stat } from "@/components/fm/Stat";
import { Status } from "@/components/fm/Status";
import { splitFirstSentence } from "@/lib/format/text";
import { type Fact, base58ToHex } from "@/lib/proof/facts";
import type { SnapshotSource } from "@/lib/proof/local";
import { type AttackRow, attackBuilds } from "@/lib/proof/sample";

const CANNOT_SHOW = [
  "That the strategy is correct or makes money. Attestation shows which code ran, not that it is good.",
  "That replay proves execution. It checks the rules against the recorded inputs.",
  "That the contract has no bugs. There is no third-party audit and no upgrade path.",
  "That trades stay private. Trades are visible on chain and slowly reveal the rules.",
];
const FACT_LABEL: Record<Fact["id"], string> = { keys: "Keys", code: "Code", strategy: "Strategy", commitment: "Commitment" };
const ATTACKS_URL = "https://github.com/zakyirsyaad/foundling/tree/main/tools/attacks";

export function ProofView({ source, facts, attacks, synthetic }: { source: SnapshotSource | null; facts: Fact[]; attacks: AttackRow[]; synthetic: boolean }) {
  return (
    <main>
      <section className="page-hero">
        <div className="wrap stack gap-4">
          <p className="eyebrow">Proof</p>
          <h1 className="display-lg max-w-[760px]">Check every claim yourself.</h1>
          <p className="lead">Four facts you can check from the chain and the repo, the attacks we ran against the contract, and what these checks cannot show.</p>
        </div>
      </section>
      <StatStrip source={source} />
      <Facts facts={facts} />
      <AttackLab attacks={attacks} liveHex={source ? base58ToHex(source.snapshot.account.codeHash) : null} />
      <CannotShow />
      <section className="section">
        <div className="wrap grid gap-6">
          <div className="cta-card">
            <div className="stack gap-2">
              <h2 className="h2">See the proof for each cycle.</h2>
              <p>Every cycle in the app shows its checks: pass, skip or fail, and why.</p>
            </div>
            <Link href="/app/cycles" className="fm-btn fm-btn--primary fm-btn--lg">Open cycles</Link>
          </div>
          {synthetic ? <p className="fm-small">The files in proofs/ are a synthetic fixture. They test the checker, not this vault.</p> : null}
        </div>
      </section>
    </main>
  );
}

/** A hash cut in the middle, with the full value on hover. */
function Short({ value }: { value: string }) {
  return <span title={value}>{truncateMiddle(value)}</span>;
}

function StatStrip({ source }: { source: SnapshotSource | null }) {
  if (source === null) {
    return (
      <section aria-label="The vault right now" className="border-t py-8">
        <div className="wrap">
          <p data-testid="proof-unreadable" className="text-muted-foreground">Vault not readable right now. The commands below still work against the chain.</p>
        </div>
      </section>
    );
  }
  const s = source.snapshot;
  return (
    <section aria-label="The vault right now" className="border-t py-8">
      <div className="wrap grid gap-3">
        <div className="stat-strip">
          <Stat label="Access keys" value={s.accessKeys.toString()} sub={s.vaultId} />
          <Stat label="Vault code hash" value={<Short value={base58ToHex(s.account.codeHash) ?? s.account.codeHash} />} sub="sha256 of the deployed code" />
          <Stat label="Strategy WASM hash" value={<Short value={s.agent.wasmHash} />} sub="Pinned in the vault" />
          <Stat label="Commitment" value={<Short value={s.agent.commitment} />} sub="Hash of the sealed parameters" />
          <Stat label="Parameters" value={s.revealed ? "Revealed" : "Sealed"} sub={s.revealed ? "Anyone can replay the rules" : "Not revealed yet"} />
        </div>
        <p data-testid="proof-source" className="fm-small mono">
          {source.kind === "sample" ? source.label : "Live vault"} · <span className="break-all">{s.vaultId}</span> · as of block #{s.blockHeight.toString()}
        </p>
      </div>
    </section>
  );
}

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <section aria-labelledby="facts" className="section">
      <div className="wrap stack gap-10">
        <div className="stack max-w-[680px] gap-3">
          <h2 id="facts" className="h1">Four facts, four commands.</h2>
          <p className="lead">Each command reads public state with the NEAR CLI or the tools in the repo. None of them needs a key.</p>
        </div>
        <ul className="border-t">
          {facts.map((f) => (
            <li key={f.id} data-fact={f.id} className="fact-row">
              <div className="stack gap-2">
                <span className="mono fm-small">{FACT_LABEL[f.id]}</span>
                <h3 className="h3">{f.title}</h3>
                {f.note ? <p className="text-muted-foreground">{f.note}</p> : null}
                {f.href ? <a href={f.href} rel="noreferrer noopener" className="text-[13px] underline underline-offset-4">The pinned binary</a> : null}
              </div>
              <div className="stack min-w-0 gap-2">
                <div className="fm-code fm-code--row fm-code--wrap">
                  <pre><code>{f.command}</code></pre>
                  <CopyButton text={f.command} label="Copy command" icon />
                </div>
                <p className="fm-small mono break-all">Now: {f.value}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Which vault build the results ran on, so a Pass is never read as a check of code it did not test. */
function AttackBuild({ attacks, liveHex }: { attacks: AttackRow[]; liveHex: string | null }) {
  const { builds, matchesLive } = attackBuilds(attacks, liveHex);
  if (builds.length === 0) return null;
  const tail = matchesLive === true ? ", the code this vault reports." : matchesLive === false ? ". That is not the code this vault reports, so these results describe the tested build." : ".";
  return (
    <p data-testid="attack-build" className="fm-small">
      Ran on vault build{builds.length > 1 ? "s" : ""}{" "}
      {builds.map((b, i) => (
        <span key={b}>{i > 0 ? ", " : null}<span className="mono break-all">sha256 {b}</span></span>
      ))}
      {tail}
    </p>
  );
}

function AttackLab({ attacks, liveHex }: { attacks: AttackRow[]; liveHex: string | null }) {
  return (
    <section aria-labelledby="attack-lab" className="section">
      <div className="wrap stack gap-8">
        <div className="section-head">
          <div className="section-head__text">
            <h2 id="attack-lab" className="h1">Attack Lab</h2>
            <p className="lead">Sandbox results. These run against a local node, not the live vault.</p>
          </div>
          <a href={ATTACKS_URL} rel="noreferrer noopener" className="fm-btn fm-btn--outline">All attacks and logs</a>
        </div>
        <div className="fm-table-wrap">
          <table className="fm-table text-sm">
            <thead>
              <tr>
                <th scope="col">Attack</th>
                <th scope="col">Expected</th>
                <th scope="col">Sandbox</th>
              </tr>
            </thead>
            <tbody>
              {attacks.map((a) => (
                <tr key={a.name}>
                  <td data-label="Attack" className="mono whitespace-nowrap">{a.name}</td>
                  <td data-label="Expected">{a.expected}</td>
                  <td data-label="Sandbox" className="whitespace-nowrap">{a.result === "Pass" || a.result === "Fail" ? <Status group="proof" word={a.result} /> : <span className="text-muted-foreground">{a.result}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack gap-1">
          <p className="fm-small">Pass means the contract refused the attack or the exit still worked. A result shows once its proof is committed from the reproducible build.</p>
          <AttackBuild attacks={attacks} liveHex={liveHex} />
        </div>
      </div>
    </section>
  );
}

function CannotShow() {
  return (
    <section aria-labelledby="cannot-show" className="section">
      <div className="wrap split">
        <div className="stack gap-3">
          <h2 id="cannot-show" className="h1">What these checks cannot show.</h2>
          <p className="lead">A check proves what it checks. These are the questions it leaves open.</p>
        </div>
        <ul className="ruled">
          {CANNOT_SHOW.map((line) => {
            const { head, rest } = splitFirstSentence(line);
            return (
              <li key={line}>
                <span className="ruled__mark mono text-[11px]" aria-hidden="true">?</span>
                <div className="grid gap-1">
                  <p className="font-semibold">{head}</p>
                  {rest ? <p className="text-muted-foreground">{rest}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
