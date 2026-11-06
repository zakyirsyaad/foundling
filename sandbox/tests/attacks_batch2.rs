//! Attack Lab, second five attacks (SPEC section 5, S3 and S4): kill-agent, governor-loosen,
//! double-redeem, forged-caller, freeze-race. Same contract as attacks_batch1.rs: each test attacks a
//! sandbox vault, writes `<name>.json` in the proof directory with its verdict and the ledger
//! before and after, and only then asserts, so `tools/attacks/<name>` can tell a breach (exit 1)
//! from a tool error (exit 2). The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as in batch 1.

mod common;
