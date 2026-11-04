"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const OPTIONS = ["system", "light", "dark"] as const;
const noop = () => () => {};

/** System by default, with a manual choice stored by next-themes. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  return (
    <div role="radiogroup" aria-label="Theme" className="fm-theme">
      {OPTIONS.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={mounted ? (theme ?? "system") === o : o === "system"} onClick={() => setTheme(o)}>
          {o[0]!.toUpperCase() + o.slice(1)}
        </button>
      ))}
    </div>
  );
}
