//! The cycle state machine. Every callback re-reads the stage, because public methods
//! can run between two hops; a callback that does not match the stage has no effect.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PromiseError};

use crate::decision::{decode, CycleFailure, Decision, Expected, MAX_DECISION_BYTES};
use crate::events::emit;
use crate::swap::SwapStep;
use crate::{now_seconds, Token, Vault, VaultExt};

const DECISION_INPUT_VERSION: u32 = 1;
const BUILD_TARGET: &str = "wasm32-wasip2";
const MAX_INSTRUCTIONS: u64 = 1_000_000_000;
const MAX_MEMORY_MB: u32 = 128;
const REQUEST_GAS: Gas = Gas::from_tgas(200);
const ON_DECISION_GAS: Gas = Gas::from_tgas(30);
const MIN_TRIGGER_GAS: Gas = Gas::from_tgas(250);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Stage {
    Idle,
    AwaitingDecision {
        nonce: u64,
        entered_block: u64,
    },
    DecisionReady {
        nonce: u64,
        expires_at: u64,
    },
    AwaitingPrice {
        nonce: u64,
        entered_block: u64,
        expires_at: u64,
    },
    Depositing {
        nonce: u64,
        attempt: u32,
        entered_at: u64,
    },
    Swapping {
        nonce: u64,
        attempt: u32,
        entered_at: u64,
    },
    Withdrawing {
        nonce: u64,
        attempt: u32,
        entered_at: u64,
        unwinding: bool,
        token: Token,
        amount: U128,
    },
    Stuck {
        nonce: u64,
        step: SwapStep,
        attempt: u32,
        since: u64,
    },
    /// A lock: a second `advance` in the same block must not send a second probe.
    Probing {
        nonce: u64,
        step: SwapStep,
        attempt: u32,
        stuck_since: u64,
        entered_at: u64,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentConfig {
    pub outlayer: AccountId,
    pub wasm_url: String,
    pub wasm_hash: String,
    pub secrets_profile: String,
    pub secrets_owner: AccountId,
    pub outlayer_deposit: U128,
    pub chain: String,
    pub commitment: String,
}

#[near]
impl Vault {
    pub fn trigger_cycle(&mut self) {
        require!(env::prepaid_gas() >= MIN_TRIGGER_GAS, "LOW_GAS");
        require!(
            env::predecessor_account_id() == self.roles.keeper,
            "NOT_KEEPER"
        );
        require!(self.stage == Stage::Idle, "NOT_IDLE");
        require!(!self.frozen, "FROZEN");
        require!(!self.halted, "HALTED");
        let now = now_seconds();
        require!(
            self.last_trigger == 0 || now >= self.last_trigger + self.policy.cooldown,
            "COOLDOWN"
        );
        let deposit = self.agent.outlayer_deposit.0;
        let epoch_len = self.policy.epoch_len;
        require!(
            self.ops_window.used(now, epoch_len) + deposit <= self.policy.ops_budget.0,
            "OPS_BUDGET"
        );
        self.require_near_floor(deposit);

        self.last_trigger = now;
        self.ops_window = self
            .ops_window
            .pruned(now, epoch_len)
            .recorded(now, deposit);
        self.mint_pending();
        self.last_nonce += 1;
        let nonce = self.last_nonce;
        self.stage = Stage::AwaitingDecision {
            nonce,
            entered_block: env::block_height(),
        };
        emit("cycle_started", &format!(r#"{{"nonce":{nonce}}}"#));

        let request = env::promise_create(
            self.agent.outlayer.clone(),
            "request_execution",
            self.request_args(nonce),
            NearToken::from_yoctonear(deposit),
            REQUEST_GAS,
        );
        let callback = env::promise_then(
            request,
            env::current_account_id(),
            "on_decision",
            json!({ "nonce": nonce }).to_string(),
            NO_DEPOSIT,
            ON_DECISION_GAS,
        );
        env::promise_return(callback);
    }

    /// Never panics. A failed run, a timeout and a lost request all arrive here as a
    /// result, and each has to bring the vault back to `Idle`.
    #[private]
    pub fn on_decision(&mut self, nonce: u64) {
        if !matches!(self.stage, Stage::AwaitingDecision { nonce: active, .. } if active == nonce) {
            return;
        }
        let result = read_result();
        let expected = self.expected_decision(nonce);
        let outcome = decode(&result, &expected);
        self.settle_decision(nonce, outcome);
    }

    /// Anyone may clear a cycle that never got its callback.
    pub fn abort_stale_cycle(&mut self) {
        let (nonce, entered_block) = match self.stage {
            Stage::AwaitingDecision {
                nonce,
                entered_block,
            }
            | Stage::AwaitingPrice {
                nonce,
                entered_block,
                ..
            } => (nonce, entered_block),
            _ => env::panic_str("NOT_AWAITING"),
        };
        require!(
            env::block_height() >= entered_block + self.policy.abort_after_blocks,
            "NOT_STALE"
        );
        emit("cycle_aborted", &format!(r#"{{"nonce":{nonce}}}"#));
        self.decision = None;
        self.stage = Stage::Idle;
    }

    pub fn expire_decision(&mut self) {
        let Stage::DecisionReady { nonce, expires_at } = self.stage else {
            env::panic_str("NOT_EXPIRED");
        };
        require!(now_seconds() >= expires_at, "NOT_EXPIRED");
        emit(
            "cycle_failed",
            &format!(r#"{{"nonce":{nonce},"code":"EXPIRED"}}"#),
        );
        self.decision = None;
        self.stage = Stage::Idle;
    }

    pub fn stage(&self) -> Stage {
        self.stage.clone()
    }

    pub fn last_nonce(&self) -> u64 {
        self.last_nonce
    }

    pub fn ops_spent(&self) -> U128 {
        U128(self.ops_window.used(now_seconds(), self.policy.epoch_len))
    }
}

impl Vault {
    fn expected_decision(&self, nonce: u64) -> Expected<'_> {
        Expected {
            vault: self.vault_id.as_str(),
            chain: &self.agent.chain,
            nonce,
            commitment: &self.agent.commitment,
            wasm_hash: &self.agent.wasm_hash,
        }
    }

    /// The one way a decision enters the vault, so fallback A only swaps the adapter.
    pub(crate) fn settle_decision(
        &mut self,
        nonce: u64,
        outcome: Result<Option<Decision>, CycleFailure>,
    ) {
        self.stage = Stage::Idle;
        match outcome {
            Err(failure) => emit(
                "cycle_failed",
                &format!(r#"{{"nonce":{nonce},"code":"{}"}}"#, failure.code()),
            ),
            Ok(None) => emit(
                "hold",
                &format!(r#"{{"nonce":{nonce},"code":"NO_DECISION"}}"#),
            ),
            Ok(Some(_)) if self.frozen || self.halted => emit(
                "rejected",
                &format!(r#"{{"nonce":{nonce},"code":"FROZEN"}}"#),
            ),
            Ok(Some(decision)) => {
                self.decision = Some(decision);
                self.stage = Stage::DecisionReady {
                    nonce,
                    expires_at: now_seconds() + self.policy.decision_ttl,
                };
                emit("decision_ready", &format!(r#"{{"nonce":{nonce}}}"#));
            }
        }
    }

    fn request_args(&self, nonce: u64) -> String {
        let now = now_seconds();
        let epoch_len = self.policy.epoch_len;
        let input = json!({
            "v": DECISION_INPUT_VERSION,
            "vault": self.vault_id,
            "nonce": nonce,
            "usdc_book": U128(self.usdc_book),
            "wnear_book": U128(self.wnear_book),
            "window_buy": U128(self.buy_window.used(now, epoch_len)),
            "window_sell": U128(self.sell_window.used(now, epoch_len)),
            // The vault rejects a breach whole, so the strategy has to size inside these.
            "limits": {
                "cap_bps": self.policy.cap_bps,
                "epoch_cap_bps": self.policy.epoch_cap_bps,
                "max_risk_bps": self.policy.max_risk_bps,
                "cap_sell_bps": self.policy.cap_sell_bps,
                "ref_dev_bps": self.policy.ref_dev_bps,
                "cap_usdc": self.policy.cap_usdc,
                "epoch_cap_usdc": self.policy.epoch_cap_usdc,
                "cap_wnear": self.policy.cap_wnear,
                "epoch_cap_wnear": self.policy.epoch_cap_wnear,
                "decimal_scale": U128(self.decimal_scale()),
            },
        });
        json!({
            "source": {
                "WasmUrl": {
                    "url": self.agent.wasm_url,
                    "hash": self.agent.wasm_hash,
                    "build_target": BUILD_TARGET,
                }
            },
            "resource_limits": {
                "max_instructions": MAX_INSTRUCTIONS,
                "max_memory_mb": MAX_MEMORY_MB,
                "max_execution_seconds": self.policy.max_execution_seconds,
            },
            "input_data": input.to_string(),
            "secrets_ref": {
                "profile": self.agent.secrets_profile,
                "account_id": self.agent.secrets_owner,
            },
            "response_format": "Json",
            "payer_account_id": self.vault_id,
        })
        .to_string()
    }
}

fn read_result() -> Result<Vec<u8>, PromiseError> {
    if env::promise_results_count() != 1 {
        return Err(PromiseError::Failed);
    }
    env::promise_result_checked(0, MAX_DECISION_BYTES)
}
