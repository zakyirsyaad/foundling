import type { Metadata } from "next";

import { PortfolioScreen } from "@/features/portfolio/PortfolioScreen";

export const metadata: Metadata = { title: "Portfolio · Foundling" };

/** RPC and the wallet only: this page never reads the history API (WEBSITE §2 rule 3). */
export default function PortfolioPage() {
  return <PortfolioScreen />;
}
