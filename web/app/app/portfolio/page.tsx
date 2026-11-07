import type { Metadata } from "next";

import { PAGE_SEO } from "@/content/seo";
import { PortfolioScreen } from "@/features/portfolio/PortfolioScreen";
import { pageMetadata } from "@/lib/seo/site";

/** Depends on the connected wallet, so it stays out of search. */
export const metadata: Metadata = pageMetadata(PAGE_SEO.portfolio);

/** RPC and the wallet only: this page never reads the history API (WEBSITE §2 rule 3). */
export default function PortfolioPage() {
  return <PortfolioScreen />;
}
