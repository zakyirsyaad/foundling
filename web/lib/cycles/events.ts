/** Every event name the vault emits (snake_case, NEP-297). `check:contract` keeps this list in step with the Rust source. */
export const KNOWN_EVENTS: readonly string[] = [
  "claim_folded", "claimed", "cycle_aborted", "cycle_failed", "cycle_started", "decision", "decision_ready",
  "deposit_queued", "depositor_added", "executed", "frozen", "guardian_change_applied", "guardian_change_scheduled",
  "halt_cleared", "halted", "hold", "initialized", "keeper_change_applied", "keeper_change_cancelled",
  "keeper_change_scheduled", "minted", "policy_tightened", "probing", "redeemed", "rejected", "revealed", "selftest",
  "setup_step", "storage_registered", "stuck", "swap_reverted", "swap_started", "transfer_failed", "unfrozen",
];
