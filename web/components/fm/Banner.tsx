import type { ReactNode } from "react";

export function Banner({ tone, title, children }: { tone: "neutral" | "warning" | "danger"; title: string; children?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} data-tone={tone} className="fm-banner">
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </div>
  );
}
