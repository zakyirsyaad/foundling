"use client";

import { StuckPanel } from "@/features/vault/StuckPanel";
import { Exits } from "./Exits";
import { Portfolio } from "./Portfolio";

/** The Portfolio page with every panel plugged in. */
export function PortfolioScreen() {
  return <Portfolio slots={{ exits: (a) => <Exits {...a} />, stuck: (a) => <StuckPanel {...a} /> }} />;
}
