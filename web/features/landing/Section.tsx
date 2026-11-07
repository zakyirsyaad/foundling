import type { ReactNode } from "react";

export interface SectionHead {
  eyebrow: string;
  title: string;
  lead?: string;
  aside?: string;
}

/** A landing section: the design's eyebrow, h2, lead and right-hand note, then the content. */
export function Section({ id, head, children, ...rest }: { id: string; head: SectionHead; children: ReactNode; "data-copy-exempt"?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="section" {...rest}>
      <div className="wrap grid gap-12">
        <Head id={id} head={head} />
        {children}
      </div>
    </section>
  );
}

export function Head({ id, head }: { id: string; head: SectionHead }) {
  return (
    <div className="section-head">
      <div className="section-head__text">
        <p className="eyebrow">{head.eyebrow}</p>
        <h2 id={`${id}-title`} className="h1">{head.title}</h2>
        {head.lead ? <p className="lead">{head.lead}</p> : null}
      </div>
      {head.aside ? <p className="section-head__aside">{head.aside}</p> : null}
    </div>
  );
}
