/**
 * Events that carry a cycle's nonce but belong to an account, often long after the cycle ended: a claim of
 * the cycle's bucket, or an older claim folded into a new one (contracts/vault/src/swap.rs). They are left
 * out of the cycle's derivation (indexer) and of its event list (API).
 */
export const NOT_CYCLE_EVENTS: readonly string[] = ["claimed", "claim_folded"];
