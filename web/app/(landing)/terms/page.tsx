import type { Metadata } from "next";

import { PAGE_SEO } from "@/content/seo";
import { ONECLICK_TOS_URL, SECTIONS, TERMS_DATE } from "@/content/terms";
import { pageMetadata } from "@/lib/seo/site";

export const metadata: Metadata = pageMetadata(PAGE_SEO.terms);

export default function TermsPage() {
  return (
    <main>
      <section className="page-hero pb-12">
        <div className="wrap stack gap-4">
          <p className="eyebrow">Terms</p>
          <h1 className="display-lg">Terms of use</h1>
          <p className="lead">Plain terms for a technical demo. <span className="mono text-[13px]">Version of {TERMS_DATE}</span></p>
        </div>
      </section>
      <section className="border-t pt-12 pb-24">
        <div className="wrap doc">
          <nav aria-label="Contents" className="toc">
            <p className="fm-label mb-2">On this page</p>
            <ol>
              {SECTIONS.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{i + 1}. {s.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="prose stack">
            {SECTIONS.map((s) => (
              <section key={s.id} aria-labelledby={s.id} className="stack gap-3">
                <h2 id={s.id} className="h2 scroll-mt-6">{s.title}</h2>
                {s.body.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {s.id === "cross-chain" ? (
                  <p>
                    <a href={ONECLICK_TOS_URL} className="underline underline-offset-4">1Click terms of service</a>
                  </p>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
