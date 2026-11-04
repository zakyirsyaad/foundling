import Link from "next/link";

import { ThemeToggle } from "@/components/fm/ThemeToggle";
import { GITHUB_URL } from "@/content/landing";

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-5 px-4 py-8 text-sm text-muted-foreground">
        <Link href="/proof" className="hover:text-foreground">Proof</Link>
        <Link href="/trust" className="hover:text-foreground">Trust</Link>
        <Link href="/terms" className="hover:text-foreground">Terms</Link>
        <a href={GITHUB_URL} className="hover:text-foreground">GitHub</a>
        <ThemeToggle />
        <span className="ml-auto">Not audited · hackathon build</span>
      </div>
    </footer>
  );
}
