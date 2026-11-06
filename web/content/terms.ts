import values from "./terms.json";

/** The lead fills these in terms.json before a production build; next.config.ts refuses "TBD". */
export const TERMS_DATE: string = values.date;
export const ONECLICK_TOS_URL: string = values.oneClickTosUrl;

export const SECTIONS: readonly { id: string; title: string; body: readonly string[] }[] = [
  { id: "what-this-is", title: "What this is", body: ["Foundling is a technical demo built for a hackathon. It is a USDC vault on NEAR whose trading is run by a sealed strategy and limited by the vault contract.", "It is not a fund, a bank, or an offer of any financial product, and nobody here gives investment advice."] },
  { id: "no-audit", title: "No audit", body: ["The contracts have not been audited by a third party. They cannot be upgraded; a bug is answered with a new vault, not a fix.", "You can lose some or all of what you deposit."] },
  { id: "your-responsibility", title: "Your responsibility", body: ["You decide whether to use the vault, and you are responsible for the laws that apply to you, including sanctions rules.", "Do not use the vault if you are not allowed to where you live or from where you connect."] },
  { id: "risks", title: "Risks", body: ["The trust and risk tables on the Trust page are part of these terms. They list who can do what, and what can go wrong."] },
  { id: "deposits-and-exits", title: "Deposits and exits", body: ["Deposits wait in a queue until the next cycle mints shares. You can cancel a queued deposit.", "You can redeem your shares at any stage, including while the vault is frozen, halted or stuck. Leaving still depends on the USDC and wNEAR contracts."] },
  { id: "cross-chain", title: "Deposits from another chain", body: ["Deposits from Base, Arbitrum or Ethereum go through 1Click, a service of NEAR Intents that this website does not run. Your use of 1Click is also governed by its own terms.", "1Click gives a deposit address with a deadline. Send only the token and amount shown, before the time shown. Funds that arrive after the address is no longer active may be lost, and this website cannot recover them.", "USDC always arrives in your own NEAR account first. Nothing enters the vault until you sign the deposit yourself."] },
  { id: "no-warranty", title: "No warranty", body: ["The website and the contracts are provided as they are, without any warranty. To the extent the law allows, the team is not liable for losses from using them."] },
  { id: "changes", title: "Changes", body: ["These terms can change. The date at the top says which version you are reading. Questions go to the GitHub repository."] },
];
