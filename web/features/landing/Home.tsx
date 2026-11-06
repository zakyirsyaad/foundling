import Link from "next/link";

import { CopyButton } from "@/components/fm/CopyButton";
import { Video } from "@/components/fm/Video";
import { BUILT_ON_FIXED, BUILT_ON_NOTE, CLOSING, GUARANTEE_LIMITS, HERO, HOW_IT_WORKS } from "@/content/landing";
import { MEDIA } from "@/content/media";
import { NOT_CLAIMED } from "@/content/not-claimed";
import { type Claim, claimText } from "@/lib/claims";
import { Section } from "./Section";

const GUARANTEE_IDS = ["born-without-keys", "g1-confidentiality", "g2-bounded-loss", "g3-exit", "g4-traceability"] as const;

export function Home({ claims, keysLine }: { claims: Claim[]; keysLine: string }) {
  const intents = claimText(claims, "near-intents");
  const advisor = claimText(claims, "near-ai-advisor");
  const keyless = claimText(claims, "born-without-keys");
  return (
    <main>
      <section id="hero" className="mx-auto max-w-[1120px] px-4 pt-24 pb-16 max-sm:pt-16">
        <h1 className="max-w-[14ch] text-[64px] leading-none font-semibold tracking-[-0.04em] max-md:text-[56px]">{keyless.downgraded ? HERO.titleUnchecked : HERO.title}</h1>
        <p className="mt-6 max-w-[65ch] text-base leading-relaxed text-muted-foreground">{HERO.lead}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/app" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Open app</Link>
          <Link href="/proof" className="rounded-md border border-input px-4 py-2 text-sm font-medium">Read the proof</Link>
        </div>
        <div className="mt-12">
          <Video {...MEDIA.hero} loop />
          <p data-testid="keys-line" className="mono mt-3 text-[13px] text-muted-foreground">{keysLine}</p>
        </div>
      </section>

      <Section id="built-on" title="Built on">
        <ul className="flex flex-wrap gap-x-8 gap-y-3 text-base">
          {BUILT_ON_FIXED.map((name) => (
            <li key={name} className="font-medium">{name}</li>
          ))}
          <li className={intents.downgraded ? "text-muted-foreground" : "font-medium"}>{intents.downgraded ? intents.text : "NEAR Intents"}</li>
          <li className={advisor.downgraded ? "text-muted-foreground" : "font-medium"}>{advisor.downgraded ? advisor.text : "NEAR AI"}</li>
        </ul>
        <p className="mt-4 text-[13px] text-muted-foreground">{BUILT_ON_NOTE}</p>
      </Section>

      <Section id="how-it-works" title="How it works">
        <ol className="grid gap-6 md:grid-cols-4">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step.id} className="rounded-lg border p-5">
              <div className="mono text-[12px] text-muted-foreground">0{i + 1}</div>
              <h3 className="mt-2 text-lg font-semibold tracking-[-0.01em]">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed">
                {step.body}
                {step.id === "decide" ? ` ${advisor.text}` : null}
              </p>
              <p className="mono mt-3 text-[12px] text-muted-foreground">{step.leaves}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="demo" title="Demo">
        <Video {...MEDIA.demo} />
      </Section>

      <Section id="guarantees" title="Guarantees">
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {GUARANTEE_IDS.map((id) => {
            const c = claimText(claims, id);
            const meta = GUARANTEE_LIMITS[id]!;
            return (
              <li key={id} className="rounded-lg border p-5" data-claim={id} data-downgraded={c.downgraded || undefined}>
                <h3 className="text-lg font-semibold tracking-[-0.01em]">{meta.title}</h3>
                <p className="mt-2 text-sm leading-relaxed">{c.text}</p>
                <p className="mt-3 text-[13px] text-muted-foreground">Limit: {meta.limit}</p>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="not-claimed" title="What we don't claim" data-copy-exempt="not-claimed">
        <ul className="grid gap-3 text-sm leading-relaxed">
          {NOT_CLAIMED.map((line) => (
            <li key={line} className="border-b pb-3">{line}</li>
          ))}
        </ul>
      </Section>

      <Section id="closing" title={CLOSING.title}>
        <div className="fm-code">
          {CLOSING.commands.map((cmd) => (
            <div key={cmd} className="flex items-center justify-between gap-4">
              <code>{cmd}</code>
              <CopyButton text={cmd} label="Copy command" />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted-foreground">{CLOSING.note}</p>
      </Section>
    </main>
  );
}
