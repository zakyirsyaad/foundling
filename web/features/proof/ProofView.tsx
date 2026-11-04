import type { Fact } from "@/lib/proof/facts";
import type { SnapshotSource } from "@/lib/proof/local";
import type { AttackRow } from "@/lib/proof/sample";
import { CopyButton } from "@/components/fm/CopyButton";

const CANNOT_SHOW = [
  "That the strategy is correct or makes money. Attestation shows which code ran, not that it is good.",
  "That replay proves execution. It checks the rules against the recorded inputs.",
  "That the contract has no bugs. There is no third-party audit and no upgrade path.",
  "That trades stay private. Trades are visible on chain and slowly reveal the rules.",
];

export function ProofView({ source, facts, attacks, synthetic }: { source: SnapshotSource | null; facts: Fact[]; attacks: AttackRow[]; synthetic: boolean }) {
  return (
    <main className="proof mx-auto grid max-w-[1120px] gap-12 px-4 py-24 max-sm:py-16">
      <h1 className="text-[48px] leading-[1.05] font-semibold tracking-[-0.035em] max-sm:text-[36px]">Check it yourself.</h1>
      {source === null ? (
        <p data-testid="proof-unreadable">Vault not readable right now. The commands below still work against the chain.</p>
      ) : (
        <p data-testid="proof-source">
          {source.kind === "sample" ? source.label : "Live vault"} · <span className="mono break-all">{source.snapshot.vaultId}</span> · as of block #{source.snapshot.blockHeight.toString()}
        </p>
      )}
      <section aria-labelledby="facts">
        <h2 id="facts">Four facts and how to check them</h2>
        <ul>
          {facts.map((f) => (
            <li key={f.id} data-fact={f.id}>
              <h3>{f.title}</h3>
              <p className="mono break-all">{f.value}</p>
              {f.note ? <p className="note">{f.note}</p> : null}
              {f.href ? <a href={f.href} rel="noreferrer noopener" className="text-[13px] underline underline-offset-4">The pinned binary</a> : null}
              <pre>
                <code>{f.command}</code>
              </pre>
              <CopyButton text={f.command} label="Copy command" />
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="attack-lab">
        <h2 id="attack-lab">Attack Lab</h2>
        <p>Sandbox results. These run against a local node, not the live vault.</p>
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
                <td data-label="Attack" className="mono">{a.name}</td>
                <td data-label="Expected" className="mono">{a.expected}</td>
                <td data-label="Sandbox">{a.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="cannot-show">
        <h2 id="cannot-show">What this page cannot show</h2>
        <ul>
          {CANNOT_SHOW.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      {synthetic ? <p className="note">The files in proofs/ are a synthetic fixture. They test the checker, not this vault.</p> : null}
    </main>
  );
}
