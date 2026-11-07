import Link from "next/link";

import { NOT_FOUND } from "@/content/seo";

export function NotFoundView() {
  return (
    <main className="section">
      <div className="wrap stack max-w-[680px] gap-4">
        <p className="eyebrow">404</p>
        <h1 className="display-lg">{NOT_FOUND.title}</h1>
        <p className="lead">{NOT_FOUND.body}</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className="fm-btn fm-btn--primary">Go to the home page</Link>
          <Link href="/app" className="fm-btn fm-btn--outline">Open app</Link>
        </div>
      </div>
    </main>
  );
}
