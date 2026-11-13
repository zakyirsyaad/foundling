import Link from "next/link";

import { CopyButton } from "@/components/fm/CopyButton";
import { LimitMeter } from "@/components/fm/LimitMeter";
import { Status } from "@/components/fm/Status";
import { Video } from "@/components/fm/Video";
import { FAQ } from "@/content/faq";
import { BUILT_ON_FIXED, BUILT_ON_NOTE, CLOSING, GUARANTEES, HEADS, HERO, HOW_IT_WORKS } from "@/content/landing";
import { MEDIA } from "@/content/media";
import { NOT_CLAIMED } from "@/content/not-claimed";
import { type Claim, claimText, keylessClaim } from "@/lib/claims";
import type { SnapshotSource } from "@/lib/proof/local";
import { limitMeters } from "@/lib/vault/overview";
import { splitFirstSentence } from "@/lib/format/text";
import { Section } from "./Section";

type ClaimLine = ReturnType<typeof claimText>;

export function Home({ claims, keysLine, source = null }: { claims: Claim[]; keysLine: string; source?: SnapshotSource | null }) {
  const advisor = claimText(claims, "near-ai-advisor");
  // Only a live read can speak against the claim; the labelled sample is another vault.
  const keyless = keylessClaim(claims, source?.kind === "live" ? source.snapshot.accessKeys : null);
  return (
    <main className="text-[14px] leading-[1.5]">
      <Hero keyless={keyless} exit={claimText(claims, "g3-exit")} keysLine={keysLine} source={source} />
      <BuiltOn advisor={advisor} intents={claimText(claims, "near-intents")} />
      <Guarantees claims={claims} keyless={keyless} source={source} />
      <HowItWorks advisor={advisor} />
      <Section id="demo" head={HEADS.demo}>
        <Video {...MEDIA.demo} />
      </Section>
      <NotClaimed />
      <Questions />
      <Closing />
    </main>
  );
}

function Hero({ keyless, exit, keysLine, source }: { keyless: ClaimLine; exit: ClaimLine; keysLine: string; source: SnapshotSource | null }) {
  const title = keyless.downgraded ? HERO.titleUnchecked : HERO.title;
  const lead = title.endsWith(HERO.accent) ? title.slice(0, -HERO.accent.length) : title;
  return (
    <section id="hero" aria-labelledby="hero-title" className="hero">
      <div className="hero__grid" aria-hidden="true" />
      <div className="wrap hero__in">
        <h1 id="hero-title" className="display-xl max-w-[760px]">
          {lead}
          {lead === title ? null : <span className="text-brand">{HERO.accent}</span>}
        </h1>
        <p className="lead max-w-[600px] text-[18px]">{HERO.lead}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/app" className="fm-btn fm-btn--primary fm-btn--lg">Open app</Link>
          <Link href="/proof" className="fm-btn fm-btn--outline fm-btn--lg">Read the proof</Link>
        </div>
        <div className="mt-6 grid w-full max-w-[920px] gap-3">
          <HeroVault source={source} keyless={keyless} exit={exit} />
          <p data-testid="keys-line" className="mono text-[13px] text-muted-foreground">{keysLine}</p>
        </div>
      </div>
    </section>
  );
}

/** The vault as the hero picture: three facts read from the chain on the server, never a number we made up. */
function HeroVault({ source, keyless, exit }: { source: SnapshotSource | null; keyless: ClaimLine; exit: ClaimLine }) {
  if (!source) {
    return (
      <div data-testid="hero-vault" className="hero-vault">
        <p className="p-6 text-muted-foreground">Vault not readable right now.</p>
      </div>
    );
  }
  const s = source.snapshot;
  const epoch = limitMeters(s).epochWindow;
  return (
    <div data-testid="hero-vault" className="hero-vault">
      <div className="hero-vault__bar">
        <span className="mono text-[13px]">{s.vaultId}</span>
        <span className="fm-small">{source.kind === "sample" ? source.label : `as of block #${s.blockHeight}`}</span>
      </div>
      <div className="hero-vault__facts">
        <div data-fact="keys">
          <p className="fm-label">Access keys</p>
          <p className="hero-vault__value">{s.accessKeys}</p>
          {/* The number is a read; the sentence is a claim, so it waits for the claim's check. */}
          <p className="fm-small">{s.accessKeys > 0 ? "The final vault is meant to have none." : keyless.downgraded ? "Read from the chain. The full check has not run yet." : "No person can sign for the vault."}</p>
        </div>
        <div data-fact="epoch">
          {epoch.cap === 0n ? (
            // A zero cap is a closed window, not a full one: no bar, so it does not read as "at the limit".
            <>
              <p className="fm-label">Traded this epoch</p>
              <p className="hero-vault__value">0</p>
            </>
          ) : (
            <LimitMeter label="Traded this epoch" used={epoch.used} cap={epoch.cap} decimals={s.assets.usdcDecimals} unit="USDC" />
          )}
          <p className="fm-small">{epoch.cap === 0n ? "The trading window is closed right now." : "The contract refuses a trade over the cap."}</p>
        </div>
        <div data-fact="exit">
          <p className="fm-label">Exit</p>
          <p className="hero-vault__value">Redeem</p>
          {/* The claim text, so a downgraded exit claim is downgraded here too. */}
          <p className="fm-small">{exit.text}</p>
        </div>
      </div>
    </div>
  );
}

/** A partner shows by name once its claim passes; until then the downgrade line stands in, greyed. */
function PartnerItem({ claim, name }: { claim: ClaimLine; name: string }) {
  return <li className={claim.downgraded ? "strip__item strip__item--pending" : "strip__item"}>{claim.downgraded ? claim.text : name}</li>;
}

function BuiltOn({ advisor, intents }: { advisor: ClaimLine; intents: ClaimLine }) {
  return (
    <section id="built-on" aria-labelledby="built-on-title" className="border-t">
      <div className="wrap strip">
        <h2 id="built-on-title" className="fm-label">Built on</h2>
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {BUILT_ON_FIXED.map((name) => (
            <li key={name} className="strip__item">{name}</li>
          ))}
          <PartnerItem claim={advisor} name="NEAR AI" />
          <PartnerItem claim={intents} name="NEAR Intents" />
        </ul>
        <p className="w-full text-center text-[12px] text-muted-foreground">{BUILT_ON_NOTE}</p>
      </div>
    </section>
  );
}

function HowItWorks({ advisor }: { advisor: ClaimLine }) {
  return (
    <Section id="how-it-works" head={HEADS.how}>
      <ol className="flow">
        {HOW_IT_WORKS.map((step, i) => (
          <li key={step.id} className="flow__step">
            <span className="flow__num" aria-hidden="true">{i + 1}</span>
            <h3 className="h3">{step.title}</h3>
            <p className="text-muted-foreground">
              {step.body}
              {step.id === "decide" ? ` ${advisor.text}` : null}
            </p>
            <p className="flow__leaves">{step.leaves}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Guarantees({ claims, keyless, source }: { claims: Claim[]; keyless: ClaimLine; source: SnapshotSource | null }) {
  return (
    <Section id="guarantees" head={HEADS.guarantees}>
      <ul className="gtiles">
        {GUARANTEES.map((g) => {
          const c = g.id === "born-without-keys" ? keyless : claimText(claims, g.id);
          return (
            <li key={g.id} className={`gtile gtile--${g.span}`} data-claim={g.id} data-downgraded={c.downgraded || undefined}>
              <span className="gcard__tag">{g.tag}</span>
              <h3 className="h3">{g.title}</h3>
              <p>{c.text}</p>
              <div className="gtile__art" data-art={g.id} aria-hidden="true">
                <Art id={g.id} source={source} />
              </div>
              <p className="gcard__foot"><b>Limit</b> {g.limit}</p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** One small picture per guarantee. Decoration only: the claim and its limit carry the meaning. */
function Art({ id, source }: { id: (typeof GUARANTEES)[number]["id"]; source: SnapshotSource | null }) {
  if (id === "born-without-keys") {
    // The number always says which vault it was read from, so it cannot pass for the claim itself.
    return (
      <div className="gtile__count">
        <span className="gtile__num">{source ? source.snapshot.accessKeys : "–"}</span>
        <span className="fm-small">{source === null ? "vault not readable" : source.kind === "sample" ? "access keys on the rehearsal vault" : "access keys now"}</span>
      </div>
    );
  }
  if (id === "g2-bounded-loss") {
    return (
      <svg viewBox="0 0 240 120" className="gtile__bars">
        <line className="capline" x1="0" x2="240" y1="34" y2="34" />
        <text x="240" y="26" textAnchor="end">cap</text>
        {[[6, 44], [36, 62], [66, 34], [126, 54], [156, 72], [186, 48], [216, 64]].map(([x, h]) => (
          <rect key={x} className="bar" x={x} y={120 - h!} width="20" height={h} rx="3" />
        ))}
        <rect className="ghost" x="96" y="6" width="20" height="114" rx="3" />
        <text className="refused" x="124" y="18">refused</text>
      </svg>
    );
  }
  if (id === "g3-exit") {
    return (
      <div className="artrows">
        {(["Frozen", "Halted", "Stuck"] as const).map((word) => (
          <div key={word}><Status group="vault" word={word} /><span>Redeem stays open</span></div>
        ))}
      </div>
    );
  }
  if (id === "g1-confidentiality") {
    return (
      <div className="artrows">
        <div><span>Parameters</span><span className="artmask"><i /><i /><i /><i /></span></div>
        <div><span>Commitment</span><span>public</span></div>
        <div><span>Rule replay</span><Status group="proof" word="Sealed" /></div>
      </div>
    );
  }
  return (
    <div className="artrows">
      <div><span>Enclave attestation</span><span>checked offline</span></div>
      <div><span>Vault and code hash</span><span>bound</span></div>
      <div><span>Recorded inputs</span><span>rechecked</span></div>
    </div>
  );
}

function Questions() {
  return (
    <Section id="faq" head={HEADS.faq} split>
      <div className="faq">
        {FAQ.map(({ q, a }) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function NotClaimed() {
  return (
    <Section id="not-claimed" head={HEADS.notClaimed} split data-copy-exempt="not-claimed">
      <ul className="ruled">
        {NOT_CLAIMED.map((line) => {
          const { head, rest } = splitFirstSentence(line);
          return (
            <li key={line}>
              <span className="ruled__mark" aria-hidden="true">
                <svg className="fm-icon size-3" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </span>
              <div className="grid gap-1">
                <p className="font-semibold">{head}</p>
                {rest ? <p className="text-muted-foreground">{rest}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Closing() {
  return (
    <section id="closing" aria-labelledby="closing-title" className="section">
      <div className="wrap flex flex-col items-center gap-6 text-center">
        <h2 id="closing-title" className="display-lg">{CLOSING.title}</h2>
        <p className="lead">{CLOSING.lead} {CLOSING.note}</p>
        <div className="fm-code fm-code--row w-full max-w-[640px]">
          <code>
            {CLOSING.commands.map((cmd) => (
              <span key={cmd} className="block"><span className="text-muted-foreground">$</span> {cmd}</span>
            ))}
          </code>
          <CopyButton text={CLOSING.commands.join("\n")} label="Copy commands" icon />
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/app" className="fm-btn fm-btn--primary">Open app</Link>
          <Link href="/proof" className="fm-btn fm-btn--outline">Read the proof</Link>
        </div>
      </div>
    </section>
  );
}
