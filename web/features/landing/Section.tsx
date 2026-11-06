import type { ReactNode } from "react";

export function Section({ id, title, children, ...rest }: { id: string; title?: string; children: ReactNode; "data-copy-exempt"?: string }) {
  return (
    <section id={id} aria-labelledby={title ? `${id}-title` : undefined} className="mx-auto max-w-[1120px] px-4 py-24 max-sm:py-16" {...rest}>
      {title ? (
        <h2 id={`${id}-title`} className="mb-12 text-[32px] leading-[1.15] font-semibold tracking-[-0.025em]">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}
