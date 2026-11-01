//! Moving a stuck swap again, from what Ref says it holds. Only the vault can change its
//! internal Ref balance, so a gap from the ledger means a hop finished without its
//! callback. A swap is never repeated, its `min_amount_out` is stale by then, and no loss
//! is ever written: whatever the reading cannot explain stays `Stuck`.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, Gas, NearToken};

use crate::cycle::Stage;
use crate::events::emit;
use crate::swap::{return_callback, Inflight, SwapStep};
use crate::{now_seconds, Book, Token, Vault, VaultExt};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const GET_DEPOSITS_GAS: Gas = Gas::from_tgas(20);
// Carries the withdraw and its callback, like `on_swapped`.
const ON_PROBE_GAS: Gas = Gas::from_tgas(75);
const MIN_ADVANCE_GAS: Gas = Gas::from_tgas(110);
const MAX_DEPOSITS_BYTES: usize = 2 * 1024;

struct StuckSwap {
    nonce: u64,
    step: SwapStep,
    attempt: u32,
    since: u64,
}

struct Held {
    token_in: u128,
    token_out: u128,
}

struct Recovery {
    token: Token,
    unwinding: bool,
    at_ref: u128,
    /// What this reading shows has reached the vault's wallet since the last one.
    arrived: u128,
}

#[near]
impl Vault {
    /// Anyone may call it. The lock goes in before the promise, so two calls in one block
    /// send one probe.
    pub fn advance(&mut self, nonce: u64) {
        require!(env::prepaid_gas() >= MIN_ADVANCE_GAS, "LOW_GAS");
        let now = now_seconds();
        let Some(stuck) = self.stuck_swap(now).filter(|swap| swap.nonce == nonce) else {
            env::panic_str("NOT_STUCK");
        };
        if !self.halted && now >= stuck.since + self.policy.halt_after {
            self.halted = true;
            emit("halted", &format!(r#"{{"nonce":{nonce}}}"#));
        }
        let attempt = stuck.attempt + 1;
        self.stage = Stage::Probing {
            nonce,
            step: stuck.step,
            attempt,
            stuck_since: stuck.since,
            entered_at: now,
        };
        emit(
            "probing",
            &format!(r#"{{"nonce":{nonce},"attempt":{attempt}}}"#),
        );

        let read = env::promise_create(
            self.assets.rhea.clone(),
            "get_deposits",
            json!({ "account_id": self.vault_id }).to_string(),
            NO_DEPOSIT,
            GET_DEPOSITS_GAS,
        );
        return_callback(
            read,
            "on_probe",
            json!({ "nonce": nonce, "attempt": attempt }),
            ON_PROBE_GAS,
        );
    }

    /// Never panics. A reading that cannot be explained changes nothing.
    #[private]
    pub fn on_probe(&mut self, nonce: u64, attempt: u32) {
        let Stage::Probing {
            nonce: active,
            step,
            attempt: current,
            stuck_since,
            ..
        } = self.stage
        else {
            return;
        };
        if active != nonce || current != attempt {
            return;
        }
        let Some(inflight) = self.inflight.clone() else {
            self.stay_stuck(nonce, step, attempt, stuck_since);
            return;
        };
        let reading = self.read_deposits(&inflight);
        let plan = reading
            .as_ref()
            .and_then(|held| self.plan(step, &inflight, held));
        let (Some(held), Some(recovery)) = (reading, plan) else {
            self.stay_stuck(nonce, step, attempt, stuck_since);
            return;
        };
        self.set_rhea(inflight.token_in, held.token_in);
        self.set_rhea(inflight.token_out, held.token_out);
        self.apply(nonce, attempt, inflight, recovery);
    }

    pub fn rhea_book(&self) -> Book {
        Book {
            usdc: U128(self.rhea_usdc),
            wnear: U128(self.rhea_wnear),
        }
    }
}

impl Vault {
    fn stuck_swap(&self, now: u64) -> Option<StuckSwap> {
        let timed_out = |entered_at: u64| now >= entered_at + self.policy.stuck_after;
        let (nonce, step, attempt, since) = match self.stage {
            Stage::Stuck {
                nonce,
                step,
                attempt,
                since,
            } => (nonce, step, attempt, since),
            Stage::Depositing {
                nonce,
                attempt,
                entered_at,
            } if timed_out(entered_at) => (nonce, SwapStep::Deposit, attempt, entered_at),
            Stage::Swapping {
                nonce,
                attempt,
                entered_at,
            } if timed_out(entered_at) => (nonce, SwapStep::Swap, attempt, entered_at),
            Stage::Withdrawing {
                nonce,
                attempt,
                entered_at,
                ..
            } if timed_out(entered_at) => (nonce, SwapStep::Withdraw, attempt, entered_at),
            Stage::Probing {
                nonce,
                step,
                attempt,
                stuck_since,
                entered_at,
            } if timed_out(entered_at) => (nonce, step, attempt, stuck_since),
            _ => return None,
        };
        Some(StuckSwap {
            nonce,
            step,
            attempt,
            since,
        })
    }

    fn read_deposits(&self, inflight: &Inflight) -> Option<Held> {
        if env::promise_results_count() != 1 {
            return None;
        }
        let bytes = env::promise_result_checked(0, MAX_DEPOSITS_BYTES).ok()?;
        let deposits: BTreeMap<String, U128> = serde_json::from_slice(&bytes).ok()?;
        let held = |token: Token| {
            deposits
                .get(self.token_account(token).as_str())
                .map(|amount| amount.0)
        };
        Some(Held {
            token_in: held(inflight.token_in)?,
            token_out: held(inflight.token_out)?,
        })
    }

    /// `None` when the reading cannot be explained by the step that was running.
    fn plan(&self, step: SwapStep, inflight: &Inflight, held: &Held) -> Option<Recovery> {
        let amount_in = inflight.amount_in.0;
        let unwind = |at_ref, arrived| Recovery {
            token: inflight.token_in,
            unwinding: true,
            at_ref,
            arrived,
        };
        let forward = |at_ref, arrived| Recovery {
            token: inflight.token_out,
            unwinding: false,
            at_ref,
            arrived,
        };
        match step {
            SwapStep::Deposit if held.token_out == 0 => {
                let refunded = amount_in.checked_sub(held.token_in)?;
                Some(unwind(held.token_in, refunded))
            }
            SwapStep::Swap if held.token_out == 0 && held.token_in == amount_in => {
                Some(unwind(held.token_in, 0))
            }
            SwapStep::Swap if held.token_in == 0 && held.token_out > 0 => {
                Some(forward(held.token_out, 0))
            }
            SwapStep::Withdraw if inflight.amount_out.is_some() && held.token_in == 0 => {
                let ledger = self.rhea_of(inflight.token_out);
                Some(forward(held.token_out, ledger.checked_sub(held.token_out)?))
            }
            SwapStep::Withdraw if inflight.amount_out.is_none() && held.token_out == 0 => {
                let ledger = self.rhea_of(inflight.token_in);
                Some(unwind(held.token_in, ledger.checked_sub(held.token_in)?))
            }
            _ => None,
        }
    }

    fn apply(&mut self, nonce: u64, attempt: u32, inflight: Inflight, recovery: Recovery) {
        let Recovery {
            token,
            unwinding,
            at_ref,
            arrived,
        } = recovery;
        let recovered = inflight.recovered.0 + arrived;
        if at_ref == 0 {
            self.settle_swap(nonce, token, recovered, unwinding);
            return;
        }
        let found_output = (!unwinding).then_some(U128(at_ref));
        self.inflight = Some(Inflight {
            recovered: U128(recovered),
            amount_out: inflight.amount_out.or(found_output),
            ..inflight
        });
        self.start_withdraw(nonce, attempt, token, at_ref, unwinding);
    }

    fn stay_stuck(&mut self, nonce: u64, step: SwapStep, attempt: u32, since: u64) {
        self.stage = Stage::Stuck {
            nonce,
            step,
            attempt,
            since,
        };
        emit(
            "stuck",
            &format!(r#"{{"nonce":{nonce},"step":"{step:?}"}}"#),
        );
    }
}
