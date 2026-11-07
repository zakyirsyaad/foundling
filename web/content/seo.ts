import { HERO } from "./landing";

/** Search titles and descriptions. Kept to the same wording rules as the page copy (no forbidden words). */
export interface PageSeo {
  title: string;
  description: string;
  path: string;
  /** False for pages that depend on a wallet or repeat per cycle: crawlable, but kept out of search. */
  index?: boolean;
}

export const SITE = {
  name: "Foundling",
  title: "Foundling · A USDC vault on NEAR",
  description: HERO.lead,
} as const;

/** Home states "born without keys" only once that claim passes, as the hero does. */
export const HOME_SEO = {
  checked: {
    title: "Foundling: a USDC vault on NEAR born without keys",
    description: "A USDC vault on NEAR born without access keys. A sealed strategy trades it, the contract enforces the limits, and you can leave without us.",
    path: "/",
  },
  unchecked: {
    title: "Foundling: a USDC vault on NEAR meant to be born without keys",
    description: "A USDC vault on NEAR meant to be born without access keys. A sealed strategy trades it, the contract enforces the limits, and you can leave without us.",
    path: "/",
  },
} as const satisfies Record<string, PageSeo>;

export const PAGE_SEO = {
  proof: {
    title: "Proof: check every claim yourself",
    description: "Four facts about the Foundling vault on NEAR, each with the command that checks it, plus the Attack Lab results and what these checks cannot show.",
    path: "/proof",
  },
  trust: {
    title: "Trust: who you rely on, and how much",
    description: "Every party the Foundling vault still relies on, what each one can do, how you could lose money, and what in the design limits each risk.",
    path: "/trust",
  },
  terms: {
    title: "Terms of use",
    description: "The terms for using Foundling, an unaudited USDC vault on NEAR: what it is, the risks, deposits and exits, deposits from another chain, and no warranty.",
    path: "/terms",
  },
  app: {
    title: "Vault overview",
    description: "The Foundling vault on NEAR as it stands now: share price, stage, the limits the contract enforces, and the last trading cycle with its proof.",
    path: "/app",
  },
  cycles: {
    title: "Cycles",
    description: "Every trading cycle of the Foundling vault on NEAR, with its outcome, the limit check, the swap transactions and the proof you can check.",
    path: "/app/cycles",
  },
  portfolio: {
    title: "Portfolio",
    description: "Connect a NEAR wallet to see your Foundling position, deposit USDC or leave the vault.",
    path: "/app/portfolio",
    index: false,
  },
  cycle: {
    title: "Cycle",
    description: "One Foundling trading cycle: its timeline, the limit check, the transactions and the proof.",
    path: "/app/cycles",
    index: false,
  },
} as const satisfies Record<string, PageSeo>;

export const NOT_FOUND = {
  title: "Page not found",
  body: "This page does not exist, or the link is out of date.",
} as const;
