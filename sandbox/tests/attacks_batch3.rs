//! Attack Lab, last five attacks (SPEC section 5): inflated-nav, deflated-sell, never-flat, setup-spam,
//! advance-race. Same contract as batch 1 and 2: each test attacks a sandbox vault, writes
//! `<name>.json` in the proof directory with its verdict and the ledger before and after, and only
//! then asserts, so `tools/attacks/<name>` can tell a breach (exit 1) from a tool error (exit 2).
//! The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as before.

mod common;
