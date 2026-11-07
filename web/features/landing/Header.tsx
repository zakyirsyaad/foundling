import Link from "next/link";

import { GITHUB_URL } from "@/content/landing";

/** The logo sits inside the "Main" navigation, as the spec's link list (home.spec) expects. */
export function Header() {
  return (
    <header className="site-head">
      <nav aria-label="Main" className="wrap site-head__in">
        <Link href="/" className="fm-logo">Foundling</Link>
        <div className="site-nav">
          <Link href="/#how-it-works" className="hide-sm">How it works</Link>
          <Link href="/proof">Proof</Link>
          <Link href="/trust">Trust</Link>
          <a href={GITHUB_URL} className="hide-sm">GitHub</a>
          <Link href="/app" className="fm-btn fm-btn--primary fm-btn--sm">Open app</Link>
        </div>
      </nav>
    </header>
  );
}
