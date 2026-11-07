import Link from "next/link";

import { ThemeToggle } from "@/components/fm/ThemeToggle";
import { GITHUB_URL } from "@/content/landing";

export function Footer() {
  return (
    <footer className="site-foot">
      <div className="wrap site-foot__in">
        <div className="grid gap-1.5">
          <Link href="/" className="fm-logo text-[18px]">Foundling</Link>
          <p className="text-[13px] text-muted-foreground">Not audited · hackathon build</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-6 text-[13px]">
          <Link href="/proof" className="hover:text-muted-foreground">Proof</Link>
          <Link href="/trust" className="hover:text-muted-foreground">Trust</Link>
          <Link href="/terms" className="hover:text-muted-foreground">Terms</Link>
          <a href={GITHUB_URL} className="hover:text-muted-foreground">GitHub</a>
        </nav>
        <ThemeToggle />
      </div>
    </footer>
  );
}
