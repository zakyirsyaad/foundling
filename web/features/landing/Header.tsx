import Link from "next/link";

import { GITHUB_URL } from "@/content/landing";

export function Header() {
  return (
    <header className="border-b">
      <nav aria-label="Main" className="mx-auto flex h-14 max-w-[1120px] items-center gap-6 px-4 text-sm">
        <Link href="/" className="font-semibold tracking-tight">
          Foundling
        </Link>
        <div className="ml-auto flex items-center gap-5 text-muted-foreground max-sm:gap-3">
          <Link href="/#how-it-works" className="hover:text-foreground max-sm:hidden">How it works</Link>
          <Link href="/proof" className="hover:text-foreground">Proof</Link>
          <Link href="/trust" className="hover:text-foreground">Trust</Link>
          <a href={GITHUB_URL} className="hover:text-foreground max-sm:hidden">GitHub</a>
          <Link href="/app" className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground">Open app</Link>
        </div>
      </nav>
    </header>
  );
}
