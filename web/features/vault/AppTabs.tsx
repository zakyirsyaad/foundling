"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app", label: "Overview" },
  { href: "/app/cycles", label: "Cycles" },
  { href: "/app/portfolio", label: "Portfolio" },
] as const;

export function AppTabs() {
  const path = usePathname();
  return (
    <nav aria-label="App" className="mx-auto max-w-[1120px] overflow-x-auto px-4">
      <ul className="flex gap-5 text-sm">
        {TABS.map((t) => {
          const active = t.href === "/app" ? path === "/app" : path?.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined} className={`inline-block border-b-2 py-3 ${active ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
