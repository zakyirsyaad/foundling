/**
 * The Attack Lab "Expected" column, in English. tools/attack-registry.json keeps the SPEC's wording
 * verbatim (tests/test_attack_lab.py checks it against the SPEC table), so the site carries its own English line per attack.
 */
export const ATTACK_EXPECTED: Readonly<Record<string, string>> = {
  "over-cap": "Rejected(OVER_CAP)",
  drip: "Rejected(OVER_EPOCH_CAP) on the decision that crosses the limit",
  replay: "NONCE_MISMATCH, EXPIRED, FROZEN, or CycleFailed; no trade",
  "bad-route": "No way out: Decision v1 has no route, asset or recipient field; extra agent fields are ignored and trades only go through the registered pool (I9); an unknown action is CycleFailed(MALFORMED)",
  "stale-price": "Rejected(PRICE_UNAVAILABLE) (or PRICE_STALE with a mocked publish_time)",
  "headline-injection": "One SellRisk lands, bounded by the wNEAR book; the same SellRisk inside the cooldown is refused COOLDOWN before it reaches OutLayer; after the cooldown the same amount finds an empty book, Rejected(OVER_BOOK); once the book is refilled the next sell lands once more and the total sold equals the total bought; a further refill that takes the rolling buy window past its epoch limit is Rejected(OVER_EPOCH_CAP). This is vault-side containment of an already-poisoned decision; the advisor itself is not exercised",
  "kill-agent": "No new cycle from any account but the keeper; in-kind redeem still works",
  "governor-loosen": "The method does not exist or is refused; a keeper rotation is only scheduled and the guardian can cancel it",
  "double-redeem": "No double payment; the balance becomes claimable",
  "forged-caller": "NOT_KEEPER for keeper-only methods; the SDK refuses #[private] callbacks (Method <name> is private); ft_on_transfer from another contract refunds the full amount; state does not change",
  "freeze-race": "FROZEN; no new trade; redeem still works",
  "inflated-nav": "Rejected(OVER_ABS_CAP) by the absolute cap (I13)",
  "deflated-sell": "Rejected(OVER_ABS_CAP) by cap_wnear and cap_sell_bps",
  "never-flat": "The vault goes back to flat (wnear_book ≤ dust_wnear) and the deposit is minted",
  "setup-spam": "At most one per target; the vault's NEAR does not drop below near_reserve",
  "advance-race": "One resend only (the Probing lock); the Rhea balance matches rhea_bal",
};
