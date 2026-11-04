import type { Metadata } from "next";

import { ONECLICK_TOS_URL, SECTIONS, TERMS_DATE } from "@/content/terms";

export const metadata: Metadata = { title: "Terms · Foundling" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-[760px] px-4 py-24 max-sm:py-16">
      <h1 className="text-[48px] leading-[1.05] font-semibold tracking-[-0.035em] max-sm:text-[36px]">Terms of use</h1>
      <p className="mono mt-3 text-[13px] text-muted-foreground">Version of {TERMS_DATE}</p>
      <nav aria-label="Contents" className="mt-8">
        <ol className="grid gap-1 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="underline-offset-4 hover:underline">{s.title}</a>
            </li>
          ))}
        </ol>
      </nav>
      {SECTIONS.map((s) => (
        <section key={s.id} aria-labelledby={s.id} className="mt-12">
          <h2 id={s.id} className="text-2xl font-semibold tracking-[-0.02em]">{s.title}</h2>
          {s.body.map((p) => (
            <p key={p} className="mt-3 leading-relaxed">{p}</p>
          ))}
          {s.id === "cross-chain" ? (
            <p className="mt-3">
              <a href={ONECLICK_TOS_URL} className="underline underline-offset-4">1Click terms of service</a>
            </p>
          ) : null}
        </section>
      ))}
    </main>
  );
}
