import type { ReactNode } from "react";

/**
 * A bordered card whose h2 is the head row. The body follows the h2 directly (so `#id + ol` finds a list body);
 * the right-hand note sits over the head row instead of wrapping the h2.
 */
export function Card({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="fm-card relative min-w-0">
      <h2 id={id} className="border-b px-5 py-4 text-lg font-semibold">{title}</h2>
      {children}
      {aside ? <div className="absolute top-4 right-5 text-[13px] leading-7 text-muted-foreground">{aside}</div> : null}
    </section>
  );
}
