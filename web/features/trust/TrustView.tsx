import { LOSS_SCENARIOS, RHEA_NOTE, ROLES_NOTE, TRUST_SHORT, WINDOW_FORMULA } from "@/content/trust";
import type { VaultSnapshot } from "@/lib/chain/types";
import { PartiesTable } from "./PartiesTable";
import { RolesTable } from "./RolesTable";
import { Rotations } from "./Rotations";

const UNREADABLE = "Vault not readable right now.";

function Head({ id, title, lead }: { id: string; title: string; lead: string }) {
  return (
    <div className="stack max-w-[680px] gap-3">
      <h2 id={id} className="h1">{title}</h2>
      <p className="lead">{lead}</p>
    </div>
  );
}

export function TrustView({ snapshot, label }: { snapshot: VaultSnapshot | null; label: string | null }) {
  return (
    <main>
      <section className="page-hero">
        <div className="wrap stack gap-4">
          <p className="eyebrow">Trust</p>
          <h1 className="display-lg max-w-[760px]">Who you trust, and how much.</h1>
          <p className="lead">Foundling takes the keys out of the vault, not the trust out of the system. Here is every party you still rely on, what each one can do, and what limits it.</p>
          {label ? <p className="mono fm-small">{label}</p> : null}
        </div>
      </section>
      <section aria-label="The short version" className="wrap pb-16">
        <div className="trio">
          {TRUST_SHORT.map((c) => (
            <div key={c.tag} className="trio__cell">
              <p className="eyebrow">{c.tag}</p>
              <h2 className="h3">{c.title}</h2>
              <p className="fm-small">{c.body}</p>
            </div>
          ))}
        </div>
      </section>
      <RolesSection snapshot={snapshot} />
      <section aria-labelledby="parties" className="section">
        <div className="wrap stack gap-8">
          <Head id="parties" title="Every party you rely on" lead="What can go wrong with each one, and what in the design limits it." />
          <PartiesTable />
        </div>
      </section>
      <LossesSection />
      <NotesSection snapshot={snapshot} />
    </main>
  );
}

function RolesSection({ snapshot }: { snapshot: VaultSnapshot | null }) {
  return (
    <section aria-labelledby="roles" className="section">
      <div className="wrap stack gap-8">
        <Head id="roles" title="Roles" lead="Who can do what to the vault. None of them can move your funds." />
        {snapshot ? <RolesTable roles={snapshot.roles} /> : <p>{UNREADABLE}</p>}
        <p className="fm-small max-w-[75ch]">{ROLES_NOTE}</p>
        <div className="fm-card flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="stack gap-0.5">
            <h3 id="rotations" className="font-semibold">Scheduled role changes</h3>
            <p className="fm-small">Changes wait out a timelock and show here before they take effect.</p>
          </div>
          <div className="text-muted-foreground">
            {snapshot ? <Rotations keeperChange={snapshot.keeperChange} guardianChange={snapshot.guardianChange} /> : <p>{UNREADABLE}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function LossesSection() {
  return (
    <section aria-labelledby="losses" className="section">
      <div className="wrap stack gap-8">
        <Head id="losses" title="How you could lose money" lead="What bounds each kind of loss, and what does not." />
        <div className="fm-table-wrap">
          <table aria-label="Loss scenarios" className="fm-table text-sm">
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">What bounds it</th>
              </tr>
            </thead>
            <tbody>
              {LOSS_SCENARIOS.map((l) => (
                <tr key={l.scenario}>
                  <th scope="row" className="font-semibold">{l.scenario}</th>
                  <td data-label="What bounds it">{l.input}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function NotesSection({ snapshot }: { snapshot: VaultSnapshot | null }) {
  return (
    <section className="section">
      <div className="wrap grid gap-4 md:grid-cols-2">
        <article aria-labelledby="window" className="fm-card stack gap-4 p-6">
          <h2 id="window" className="h2">When a swap gets stuck</h2>
          <p>{WINDOW_FORMULA}</p>
          {snapshot ? (
            <p className="mono fm-small">
              stuck_after = {snapshot.policy.stuckAfter.toString()} s · halt_after = {snapshot.policy.haltAfter.toString()} s
            </p>
          ) : null}
        </article>
        <article aria-labelledby="rhea" className="fm-card stack gap-3 p-6">
          <h2 id="rhea" className="h2">The Rhea exploit</h2>
          <p className="text-muted-foreground">{RHEA_NOTE}</p>
        </article>
      </div>
    </section>
  );
}
