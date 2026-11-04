import type { Metadata } from "next";

import { Portfolio } from "@/features/portfolio/Portfolio";

export const metadata: Metadata = { title: "Portfolio · Foundling" };

/** RPC and the wallet only: this page never reads the history API (WEBSITE §2 rule 3). */
export default function PortfolioPage() {
  return <Portfolio />;
}
