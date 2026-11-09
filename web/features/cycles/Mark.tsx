import type { EventMark } from "@/lib/cycles/outcome";

const MARK_PATH: Record<EventMark, string> = { done: "M20 6 9 17l-5-5", stop: "M18 6 6 18M6 6l12 12", wait: "M5 12h14" };

/** A filled check for a step that went through; an outlined cross or dash for a refusal, failure or pause. */
export function Mark({ mark }: { mark: EventMark }) {
  return (
    <span aria-hidden="true" className={`inline-grid size-5 shrink-0 place-items-center rounded-full ${mark === "done" ? "bg-foreground text-background" : "border border-foreground text-foreground"}`}>
      <svg className="fm-icon size-3" viewBox="0 0 24 24"><path d={MARK_PATH[mark]} /></svg>
    </span>
  );
}
