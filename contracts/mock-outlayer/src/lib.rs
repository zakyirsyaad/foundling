//! MOCK OUTLAYER for sandbox and testnet. Real OutLayer cannot be told to return a null,
//! a broken or an oversize answer on demand, and the vault has to be proven against each.
//! It takes `request_execution` with the real argument shape and answers from a queue the
//! test fills with `set_next`, so the vault's `on_decision` sees what a real run could give.
//!
//! It answers in the same transaction instead of yielding, so it cannot stage a timeout,
//! a resolve at block 199, or a late callback.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// Resume payloads above this fail on real OutLayer.
pub const MAX_RESPONSE_BYTES: usize = 1024;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionTemplate {
    pub chain: String,
    pub commitment: String,
    pub wasm_hash: String,
    /// `none`, `buy_risk` or `sell_risk`.
    pub action: String,
    pub amount_in: U128,
    pub ref_price: U128,
    /// The vault and nonce come from the request's `input_data`. Set these to stage a
    /// replayed or foreign decision.
    pub nonce: Option<u64>,
    pub vault: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    /// The run failed or timed out: OutLayer answers `null`.
    Null,
    /// `request_execution` itself panics, as when OutLayer is paused or underpaid.
    Failed,
    /// These bytes, verbatim: broken JSON, a wrong shape, or anything over 1024 bytes.
    Raw { payload: String },
    /// A Decision v1 bound to the vault and nonce that asked.
    Decision { template: DecisionTemplate },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Recorded {
    pub caller: AccountId,
    pub deposit: U128,
    pub payer_account_id: Option<String>,
    pub source: String,
    pub resource_limits: String,
    pub secrets_ref: String,
    pub input_data: String,
    pub response_len: u32,
    /// The answer is over the 1024-byte limit real OutLayer enforces.
    pub oversize: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    owner: AccountId,
    queue: Vec<Mode>,
    requests: u64,
    last: Option<Recorded>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init: only the mock account"
        );
        Self {
            owner,
            queue: Vec::new(),
            requests: 0,
            last: None,
        }
    }

    /// Queues the answer for the next request. An empty queue answers `null`.
    pub fn set_next(&mut self, mode: Mode) {
        self.require_owner();
        self.queue.push(mode);
    }

    pub fn clear_queue(&mut self) {
        self.require_owner();
        self.queue.clear();
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<String>,
        params: Option<Value>,
    ) {
        let _ = (response_format, params);
        let mode = if self.queue.is_empty() {
            Mode::Null
        } else {
            self.queue.remove(0)
        };
        require!(mode != Mode::Failed, "MOCK_OUTLAYER: configured to fail");
        let input = input_data.unwrap_or_default();
        let answer = answer_bytes(&mode, &input);
        let oversize = answer.len() > MAX_RESPONSE_BYTES;
        self.requests += 1;
        self.last = Some(Recorded {
            caller: env::predecessor_account_id(),
            deposit: U128(env::attached_deposit().as_yoctonear()),
            payer_account_id,
            source: source.to_string(),
            resource_limits: resource_limits.map(|v| v.to_string()).unwrap_or_default(),
            secrets_ref: secrets_ref.map(|v| v.to_string()).unwrap_or_default(),
            input_data: input,
            response_len: answer.len() as u32,
            oversize,
        });
        if oversize {
            env::log_str(&format!(
                "MOCK_OUTLAYER: oversize answer, {} bytes",
                answer.len()
            ));
        }
        env::value_return(&answer);
    }

    pub fn last_request(&self) -> Option<Recorded> {
        self.last.clone()
    }

    pub fn request_count(&self) -> u64 {
        self.requests
    }

    pub fn queued(&self) -> u32 {
        self.queue.len() as u32
    }
}

impl MockOutlayer {
    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
    }
}

fn answer_bytes(mode: &Mode, input_data: &str) -> Vec<u8> {
    match mode {
        Mode::Null | Mode::Failed => b"null".to_vec(),
        Mode::Raw { payload } => payload.clone().into_bytes(),
        Mode::Decision { template } => decision_bytes(template, input_data),
    }
}

fn decision_bytes(template: &DecisionTemplate, input_data: &str) -> Vec<u8> {
    let input: Value = serde_json::from_str(input_data).unwrap_or(Value::Null);
    let vault = template
        .vault
        .clone()
        .or_else(|| input["vault"].as_str().map(str::to_string))
        .unwrap_or_default();
    let nonce = template
        .nonce
        .or_else(|| input["nonce"].as_u64())
        .unwrap_or_default();
    json!({
        "v": 1,
        "vault": vault,
        "chain": template.chain,
        "nonce": nonce,
        "regime": "undetermined",
        "action": template.action,
        "amount_in": template.amount_in,
        "ref_price": template.ref_price,
        "commitment": template.commitment,
        "inputs_digest": "0".repeat(64),
        "obs": {"pa": 0, "pb": 0, "ta": 0, "tb": 0, "ai_flag": 2, "ai_conf": 0},
        "wasm_hash": template.wasm_hash,
    })
    .to_string()
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    use super::*;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn call_as(who: &str, deposit: u128) {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(account("outlayer.testnet"))
            .predecessor_account_id(account(who))
            .attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(context.build());
    }

    fn mock() -> MockOutlayer {
        call_as("outlayer.testnet", 0);
        MockOutlayer::init(account("owner.testnet"))
    }

    fn template() -> DecisionTemplate {
        DecisionTemplate {
            chain: "testnet".to_string(),
            commitment: "c".repeat(64),
            wasm_hash: "bb".to_string(),
            action: "buy_risk".to_string(),
            amount_in: U128(7_000_000),
            ref_price: U128(450_000_000),
            nonce: None,
            vault: None,
        }
    }

    fn request(mock: &mut MockOutlayer, input: &str) {
        call_as("vault.owner.testnet", 5);
        mock.request_execution(
            json!({"WasmUrl": {"url": "https://x/s.wasm", "hash": "bb"}}),
            Some(json!({"max_execution_seconds": 45})),
            Some(input.to_string()),
            None,
            None,
            Some("vault.owner.testnet".to_string()),
            None,
        );
    }

    #[test]
    fn a_decision_takes_the_vault_and_nonce_from_the_request() {
        let bytes = decision_bytes(&template(), r#"{"vault":"v.near","nonce":9}"#);

        let decision: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(decision["vault"], "v.near");
        assert_eq!(decision["nonce"], 9);
        assert_eq!(decision["action"], "buy_risk");
        assert_eq!(decision["amount_in"], "7000000");
    }

    #[test]
    fn a_template_can_override_the_nonce_to_stage_a_replay() {
        let replay = DecisionTemplate {
            nonce: Some(1),
            ..template()
        };

        let decision: Value =
            serde_json::from_slice(&decision_bytes(&replay, r#"{"vault":"v.near","nonce":9}"#))
                .unwrap();

        assert_eq!(decision["nonce"], 1);
    }

    #[test]
    fn a_valid_decision_stays_under_the_target_size() {
        let bytes = decision_bytes(&template(), r#"{"vault":"vault.owner.near","nonce":1}"#);

        assert!(bytes.len() < 600);
    }

    #[test]
    fn the_queue_is_used_in_order_then_answers_null() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Raw {
            payload: "first".to_string(),
        });
        mock.set_next(Mode::Raw {
            payload: "second".to_string(),
        });

        request(&mut mock, "{}");
        assert_eq!(mock.last_request().unwrap().response_len, 5);
        request(&mut mock, "{}");
        assert_eq!(mock.last_request().unwrap().response_len, 6);
        request(&mut mock, "{}");

        assert_eq!(mock.last_request().unwrap().response_len, 4);
        assert_eq!(mock.request_count(), 3);
        assert_eq!(mock.queued(), 0);
    }

    #[test]
    fn an_oversize_answer_is_flagged_and_logged() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Raw {
            payload: "x".repeat(MAX_RESPONSE_BYTES + 1),
        });

        request(&mut mock, "{}");

        assert!(mock.last_request().unwrap().oversize);
        assert!(get_logs().iter().any(|log| log.contains("oversize answer")));
    }

    #[test]
    fn an_answer_at_the_limit_is_not_oversize() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Raw {
            payload: "x".repeat(MAX_RESPONSE_BYTES),
        });

        request(&mut mock, "{}");

        assert!(!mock.last_request().unwrap().oversize);
    }

    #[test]
    fn the_request_is_recorded_with_deposit_and_payer() {
        let mut mock = mock();

        request(&mut mock, r#"{"nonce":1}"#);

        let last = mock.last_request().unwrap();
        assert_eq!(last.deposit, U128(5));
        assert_eq!(
            last.payer_account_id.as_deref(),
            Some("vault.owner.testnet")
        );
        assert_eq!(last.input_data, r#"{"nonce":1}"#);
    }

    #[test]
    #[should_panic(expected = "configured to fail")]
    fn failed_mode_panics_the_request() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Failed);

        request(&mut mock, "{}");
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_the_next_answer() {
        let mut mock = mock();
        call_as("stranger.testnet", 0);

        mock.set_next(Mode::Null);
    }
}
