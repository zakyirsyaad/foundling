export const ROLES_NOTE =
  "Foundling is built by a team of two, so these roles are split between two teammates, not between independent parties. The lead holds the governor and keeper roles. The other teammate holds only the guardian role. Whoever holds these keys, the contract still enforces the caps, moves tokens only to share holders and Rhea, and keeps redeem open while frozen.";

export const PARTY_GROUPS: readonly { group: string; rows: readonly { party: string; could: string; bounded: string }[] }[] = [
  {
    group: "Chain and tokens",
    rows: [
      { party: "USDC contract and its issuer", could: "Freeze or block USDC, including USDC on its way out of the vault.", bounded: "Nothing on our side. Exits depend on it." },
      { party: "wNEAR contract", could: "Fail a transfer of wNEAR.", bounded: "A failed transfer is kept in claimable and can be withdrawn later." },
    ],
  },
  {
    group: "Trading",
    rows: [
      { party: "Rhea contracts and their DAO", could: "Pause the exchange, freeze tokens, or upgrade the contract.", bounded: "The vault trades only pool 4512 and its two tokens, fixed at init. A stuck swap has a recovery path." },
      { party: "Rhea aggregate oracle and its DAO", could: "Move the price the vault uses; the DAO can upgrade the oracle at once.", bounded: "Per-trade caps, price age and price width checks, and a deviation check against the pool." },
    ],
  },
  {
    group: "Strategy and proofs",
    rows: [
      { party: "OutLayer operator", could: "Withhold a decision, or run the enclave with its full-access key.", bounded: "No decision means no trade. Caps hold whatever the decision is." },
      { party: "Intel TDX, NVIDIA and the Phala host", could: "Break the enclave and read the sealed parameters.", bounded: "Caps still hold. Sealing is lost, not funds." },
      { party: "NEAR AI Cloud", could: "Answer badly or not at all.", bounded: "Its advice can only lower exposure. A missing answer blocks a buy, never a sell." },
    ],
  },
  {
    group: "Website and deposits",
    rows: [
      { party: "This website and its server", could: "Show you a misleading screen, or a false proof result.", bounded: "Every action has a CLI command, and every proof has a command to check it yourself." },
      { party: "Wallet executor code", could: "The wallet connector loads each wallet's code from a third party at run time, unpinned. A changed executor can ask your wallet to sign any transaction your key allows, including transfers that have nothing to do with the vault.", bounded: "Only your wallet's own confirmation screen. Read it before you sign." },
      { party: "1Click (NEAR Intents)", could: "Give a wrong deposit address, or fail or refund a swap.", bounded: "The website checks the quote signature and every field before it shows an address, and USDC lands in your own NEAR account first." },
    ],
  },
];

export const LOSS_SCENARIOS: readonly { scenario: string; input: string }[] = [
  { scenario: "A run of bad trades", input: "Each trade is capped, but losses add up across cycles. Only the book value bounds the total." },
  { scenario: "A wrong oracle price", input: "Caps, price age, price width and the pool deviation check limit one trade, not a series." },
  { scenario: "A frozen USDC or wNEAR balance", input: "Exits wait on the token contract." },
  { scenario: "A contract bug", input: "There is no audit and no upgrade. The answer is a new vault." },
];

export const RHEA_NOTE =
  "On 2026-04-16 an attacker built a swap route through a pool of fake tokens on Rhea and opened margin positions, for a loss of about 18.4 million USD by Rhea's post-mortem. Margin trading was stopped for good. The vault is not exposed to that pattern: its pool and both tokens are fixed at init with no method to change them, so no route through another pool can be formed.";

export const WINDOW_FORMULA =
  "A swap step that gets no answer for stuck_after seconds can be advanced by anyone. If it is still stuck halt_after seconds after it first stalled, the next advance halts the vault until the governor clears it. Redeem stays open throughout.";
