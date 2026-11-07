import Link from "next/link";

import { CopyButton } from "@/components/fm/CopyButton";
import { Video } from "@/components/fm/Video";
import { BUILT_ON_FIXED, BUILT_ON_NOTE, CLOSING, GUARANTEES, HEADS, HERO, HOW_IT_WORKS } from "@/content/landing";
import { MEDIA } from "@/content/media";
import { NOT_CLAIMED } from "@/content/not-claimed";
import { type Claim, claimText } from "@/lib/claims";
import { Head, Section } from "./Section";

/** "Returns or alpha." stays one bold line; a longer entry splits into a bold first sentence and the rest. */
export function splitFirstSentence(line: string): { head: string; rest: string | null } {
  const i = line.indexOf(". ");
  return i < 0 ? { head: line, rest: null } : { head: line.slice(0, i + 1), rest: line.slice(i + 2) };
}

export function Home({ claims, keysLine }: { claims: Claim[]; keysLine: string }) {
  const intents = claimText(claims, "near-intents");
  const advisor = claimText(claims, "near-ai-advisor");
  const keyless = claimText(claims, "born-without-keys");
  return (
    <main className="text-[14px] leading-[1.5]">
      <section id="hero" aria-labelledby="hero-title" className="hero">
        <div className="hero__grid" aria-hidden="true" />
        <div className="wrap hero__in">
          <h1 id="hero-title" className="display-xl max-w-[760px]">{keyless.downgraded ? HERO.titleUnchecked : HERO.title}</h1>
          <p className="lead max-w-[600px] text-[18px]">{HERO.lead}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/app" className="fm-btn fm-btn--primary fm-btn--lg">Open app</Link>
            <Link href="/proof" className="fm-btn fm-btn--outline fm-btn--lg">Read the proof</Link>
          </div>
          <div className="mt-6 grid w-full max-w-[880px] gap-3">
            <Video {...MEDIA.hero} loop />
            <p data-testid="keys-line" className="mono text-[13px] text-muted-foreground">{keysLine}</p>
          </div>
        </div>
      </section>

      <section id="built-on" aria-labelledby="built-on-title" className="border-t">
        <div className="wrap strip">
          <h2 id="built-on-title" className="label">Built on</h2>
          <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {BUILT_ON_FIXED.map((name) => (
              <li key={name} className="strip__item">{name}</li>
            ))}
            <li className={advisor.downgraded ? "strip__item strip__item--pending" : "strip__item"}>{advisor.downgraded ? advisor.text : "NEAR AI"}</li>
            <li className={intents.downgraded ? "strip__item strip__item--pending" : "strip__item"}>{intents.downgraded ? intents.text : "NEAR Intents"}</li>
          </ul>
          <p className="w-full text-center text-[12px] text-muted-foreground">{BUILT_ON_NOTE}</p>
        </div>
      </section>

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

      <Section id="demo" head={HEADS.demo}>
        <Video {...MEDIA.demo} />
      </Section>

      <Section id="guarantees" head={HEADS.guarantees}>
        <ul className="gcards">
          {GUARANTEES.map((g) => {
            const c = claimText(claims, g.id);
            return (
              <li key={g.id} className={`gcard ${g.wide ? "gcard--wide" : "gcard--third"}`} data-claim={g.id} data-downgraded={c.downgraded || undefined}>
                <span className="gcard__tag">{g.tag}</span>
                <h3 className="h3">{g.title}</h3>
                <p>{c.text}</p>
                <p className="gcard__foot"><b>Limit</b> {g.limit}</p>
              </li>
            );
          })}
        </ul>
      </Section>

      <section id="not-claimed" aria-labelledby="not-claimed-title" className="section" data-copy-exempt="not-claimed">
        <div className="wrap split">
          <Head id="not-claimed" head={HEADS.notClaimed} />
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
        </div>
      </section>

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
    </main>
  );
}
