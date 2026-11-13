/** The first questions a visitor asks. Plain answers; the longer ones live on /proof and /trust. */
export const FAQ: readonly { q: string; a: string }[] = [
  { q: "What is Foundling?", a: "A USDC vault on NEAR, built for the NEAR Hackathon. People put USDC in, a strategy trades it between USDC and wNEAR, and each holder owns a share of what the vault holds." },
  { q: "What does \"born without keys\" mean?", a: "On NEAR, whoever holds an account's access key can do anything with that account. A vault born without keys is created with no access key at all, so no person can sign for it and only its own code moves funds. The Proof page shows how many keys this vault has right now." },
  { q: "Can I lose money?", a: "Yes. The strategy trades, and trades can lose. The contract caps how much can move per trade and per epoch, but losses can add up over time. Nobody outside the team has audited the code. Do not put in funds you cannot lose." },
  { q: "How do I get my funds out?", a: "With Redeem in the app, or with one CLI command that needs no website. You receive your share in USDC and wNEAR. Redeem is built to keep working when trading is frozen, halted or stuck, and it depends on the USDC and wNEAR contracts." },
  { q: "Do I have to trust you?", a: "Less than usual, not zero. No role on the contract can move your funds, but the team holds the governor and keeper roles, and you still rely on the enclave hardware, OutLayer, Rhea and the USDC issuer. The Trust page lists each one." },
];
