import { LOSS_SCENARIOS, RHEA_NOTE, ROLES_NOTE, WINDOW_FORMULA } from "@/content/trust";
import type { VaultSnapshot } from "@/lib/chain/types";
import { PartiesTable } from "./PartiesTable";
import { RolesTable } from "./RolesTable";
import { Rotations } from "./Rotations";

export function TrustView({ snapshot, label }: { snapshot: VaultSnapshot | null; label: string | null }) {
  return (
    <main className="mx-auto grid max-w-[1120px] gap-16 px-4 py-24 max-sm:py-16">
      <header>
        <h1 className="text-[48px] leading-[1.05] font-semibold tracking-[-0.035em] max-sm:text-[36px]">Who you trust</h1>
        <p className="mt-4 max-w-[65ch] text-muted-foreground">Who can do what to this vault, what they cannot do, and what can go wrong.</p>
        {label ? <p className="mono mt-2 text-[13px] text-muted-foreground">{label}</p> : null}
      </header>
      <section aria-labelledby="roles">
        <h2 id="roles" className="mb-4 text-2xl font-semibold">Roles</h2>
        {snapshot ? <RolesTable roles={snapshot.roles} /> : <p>Vault not readable right now.</p>}
        <p className="mt-4 max-w-[75ch] text-sm text-muted-foreground">{ROLES_NOTE}</p>
      </section>
      <section aria-labelledby="rotations">
        <h2 id="rotations" className="mb-4 text-2xl font-semibold">Scheduled rotations</h2>
        {snapshot ? <Rotations keeperChange={snapshot.keeperChange} guardianChange={snapshot.guardianChange} /> : <p>Vault not readable right now.</p>}
      </section>
      <section aria-labelledby="parties">
        <h2 id="parties" className="mb-4 text-2xl font-semibold">Who you trust, and what limits them</h2>
        <PartiesTable />
      </section>
      <section aria-labelledby="window">
        <h2 id="window" className="mb-4 text-2xl font-semibold">When a swap gets stuck</h2>
        <p className="max-w-[75ch]">{WINDOW_FORMULA}</p>
        {snapshot ? (
          <p className="mono mt-2 text-[13px] text-muted-foreground">
            stuck_after = {snapshot.policy.stuckAfter.toString()} s · halt_after = {snapshot.policy.haltAfter.toString()} s
          </p>
        ) : null}
      </section>
      <section aria-labelledby="losses">
        <h2 id="losses" className="mb-4 text-2xl font-semibold">How you could lose money</h2>
        <table aria-label="Loss scenarios" className="w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">What bounds it</th>
            </tr>
          </thead>
          <tbody>
            {LOSS_SCENARIOS.map((l) => (
              <tr key={l.scenario}>
                <th scope="row">{l.scenario}</th>
                <td>{l.input}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="rhea">
        <h2 id="rhea" className="mb-4 text-2xl font-semibold">The Rhea exploit</h2>
        <p className="max-w-[75ch]">{RHEA_NOTE}</p>
      </section>
    </main>
  );
}
