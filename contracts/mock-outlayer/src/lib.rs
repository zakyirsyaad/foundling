//! MOCK OUTLAYER for sandbox and testnet. Real OutLayer cannot be told to return a null,
//! a broken or an oversize answer on demand, and the vault has to be proven against each.
//! It takes `request_execution` with the real argument shape and answers from a queue the
//! test fills with `set_next`, so the vault's `on_decision` sees what a real run could give.
//!
//! It answers in the same transaction instead of yielding, so it cannot stage a timeout,
//! a resolve at block 199, or a late callback.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const FAIL_GAS: Gas = Gas::from_tgas(5);

/// What one run costs, inside the 0.0012-0.0025 NEAR SPEC records for a real run. The rest
/// of the attached deposit goes back to the payer, as real OutLayer does, so a vault's
/// balance falls by about this per cycle and not by the whole `outlayer_deposit`.
pub const RUN_FEE: NearToken = NearToken::from_yoctonear(2_000_000_000_000_000_000_000);

/// The size the vault's `MAX_DECISION_BYTES` rejects above. The mock still delivers a
/// bigger answer and flags it, so the limit under test is the vault's, not the mock's.
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
    /// The request fails, as when OutLayer is paused: the vault's callback sees a failed
    /// result and the whole deposit comes back. It is a failing call returned from
    /// `request_execution`, not a panic in it, because a panic would roll back the queue
    /// pop and the same entry would fire on every later request. A deposit under
    /// `RUN_FEE` fails the same way.
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
    /// The answer is over `MAX_RESPONSE_BYTES`, which the vault rejects.
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
        let deposit = env::attached_deposit();
        let underpaid = deposit < RUN_FEE;
        let failed = mode == Mode::Failed || underpaid;
        let input = input_data.unwrap_or_default();
        let answer = if underpaid {
            Vec::new()
        } else {
            answer_bytes(&mode, &input)
        };
        let oversize = answer.len() > MAX_RESPONSE_BYTES;
        let payer = payer_account_id
            .as_deref()
            .and_then(|payer| payer.parse::<AccountId>().ok())
            .unwrap_or_else(env::predecessor_account_id);
        self.requests += 1;
        self.last = Some(Recorded {
            caller: env::predecessor_account_id(),
            deposit: U128(deposit.as_yoctonear()),
            payer_account_id,
            source: source.to_string(),
            resource_limits: resource_limits.map(|v| v.to_string()).unwrap_or_default(),
            secrets_ref: secrets_ref.map(|v| v.to_string()).unwrap_or_default(),
            input_data: input,
            response_len: answer.len() as u32,
            oversize,
        });
        if failed {
            if !deposit.is_zero() {
                let _ = Promise::new(env::predecessor_account_id()).transfer(deposit);
            }
            let call = env::promise_create(
                env::current_account_id(),
                "mock_fail",
                "{}",
                NearToken::from_yoctonear(0),
                FAIL_GAS,
            );
            env::promise_return(call);
            return;
        }
        let change = deposit.saturating_sub(RUN_FEE);
        if !change.is_zero() {
            let _ = Promise::new(payer).transfer(change);
        }
        if oversize {
            env::log_str(&format!(
                "MOCK_OUTLAYER: oversize answer, {} bytes",
                answer.len()
            ));
        }
        env::value_return(&answer);
    }

    /// Only reached through a `Failed` answer.
    #[private]
    pub fn mock_fail(&self) {
        env::panic_str("MOCK_OUTLAYER: configured to fail");
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

    pub fn run_fee(&self) -> U128 {
        U128(RUN_FEE.as_yoctonear())
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
        Mode::Null => b"null".to_vec(),
        Mode::Failed => Vec::new(),
        Mode::Raw { payload } => payload.clone().into_bytes(),
        Mode::Decision { template } => decision_bytes(template, input_data),
    }
}

fn decision_bytes(template: &DecisionTemplate, input_data: &str) -> Vec<u8> {
    let input: Value = serde_json::from_str(input_data).unwrap_or(Value::Null);
    // A missing value must be loud: an empty vault or nonce 0 would reach the vault as a
    // nonce mismatch, and an input shape that drifted would look like a replay attack.
    let vault = template
        .vault
        .clone()
        .or_else(|| input["vault"].as_str().map(str::to_string))
        .unwrap_or_else(|| {
            env::panic_str("MOCK_OUTLAYER: input_data has no vault and the template sets none")
        });
    let nonce = template
        .nonce
        .or_else(|| input["nonce"].as_u64())
        .unwrap_or_else(|| {
            env::panic_str("MOCK_OUTLAYER: input_data has no nonce and the template sets none")
        });
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
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
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

    /// 0.01 NEAR, comfortably over `RUN_FEE`.
    const DEPOSIT: u128 = 10_000_000_000_000_000_000_000;

    fn request(mock: &mut MockOutlayer, input: &str) {
        request_with(mock, "vault.owner.testnet", DEPOSIT, input);
    }

    fn request_with(mock: &mut MockOutlayer, caller: &str, deposit: u128, input: &str) {
        call_as(caller, deposit);
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
        assert_eq!(last.deposit, U128(DEPOSIT));
        assert_eq!(
            last.payer_account_id.as_deref(),
            Some("vault.owner.testnet")
        );
        assert_eq!(last.input_data, r#"{"nonce":1}"#);
    }

    fn receipts_to(receiver: &str) -> Vec<MockAction> {
        get_created_receipts()
            .into_iter()
            .filter(|receipt| receipt.receiver_id == account(receiver))
            .flat_map(|receipt| receipt.actions)
            .collect()
    }

    #[test]
    fn failed_mode_hands_back_a_failing_call_instead_of_panicking() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Failed);
        mock.set_next(Mode::Null);

        request(&mut mock, "{}");

        let calls: Vec<String> = receipts_to("outlayer.testnet")
            .into_iter()
            .filter_map(|action| match action {
                MockAction::FunctionCallWeight { method_name, .. } => {
                    Some(String::from_utf8(method_name).unwrap())
                }
                _ => None,
            })
            .collect();
        assert_eq!(calls, vec!["mock_fail".to_string()]);
        assert_eq!(mock.queued(), 1, "the Failed entry is consumed");
        assert_eq!(mock.request_count(), 1);
    }

    #[test]
    fn the_request_after_a_failed_one_gets_the_next_answer() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Failed);
        mock.set_next(Mode::Raw {
            payload: "next".to_string(),
        });

        request(&mut mock, "{}");
        request(&mut mock, "{}");

        assert_eq!(mock.last_request().unwrap().response_len, 4);
        assert_eq!(mock.queued(), 0);
    }

    #[test]
    fn failed_mode_gives_the_deposit_back_to_the_caller() {
        let mut mock = mock();
        call_as("owner.testnet", 0);
        mock.set_next(Mode::Failed);

        request(&mut mock, "{}");

        assert_eq!(
            refunds_to("vault.owner.testnet"),
            vec![NearToken::from_yoctonear(DEPOSIT)]
        );
    }

    fn refunds_to(who: &str) -> Vec<NearToken> {
        receipts_to(who)
            .into_iter()
            .filter_map(|action| match action {
                MockAction::Transfer { deposit, .. } => Some(deposit),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_run_keeps_the_fee_and_refunds_the_rest() {
        let mut mock = mock();

        request(&mut mock, "{}");

        let change = NearToken::from_yoctonear(DEPOSIT - RUN_FEE.as_yoctonear());
        assert_eq!(refunds_to("vault.owner.testnet"), vec![change]);
    }

    #[test]
    fn the_change_goes_to_the_payer_not_to_the_caller() {
        let mut mock = mock();

        request_with(&mut mock, "keeper.testnet", DEPOSIT, "{}");

        assert!(refunds_to("keeper.testnet").is_empty());
        assert_eq!(refunds_to("vault.owner.testnet").len(), 1);
    }

    #[test]
    fn a_deposit_under_the_fee_fails_like_a_failed_request() {
        let mut mock = mock();
        let short = RUN_FEE.as_yoctonear() - 1;

        request_with(&mut mock, "vault.owner.testnet", short, "{}");

        assert_eq!(
            refunds_to("vault.owner.testnet"),
            vec![NearToken::from_yoctonear(short)]
        );
        let last = mock.last_request().unwrap();
        assert_eq!(last.response_len, 0);
        assert_eq!(mock.queued(), 0);
    }

    #[test]
    #[should_panic(expected = "has no vault")]
    fn a_decision_without_a_vault_is_loud() {
        decision_bytes(&template(), r#"{"nonce":1}"#);
    }

    #[test]
    #[should_panic(expected = "has no nonce")]
    fn a_decision_without_a_nonce_is_loud() {
        decision_bytes(&template(), r#"{"vault":"v.near"}"#);
    }

    #[test]
    fn a_template_that_sets_both_needs_nothing_from_the_input() {
        let staged = DecisionTemplate {
            nonce: Some(7),
            vault: Some("other.near".to_string()),
            ..template()
        };

        let decision: Value = serde_json::from_slice(&decision_bytes(&staged, "not json")).unwrap();

        assert_eq!(decision["vault"], "other.near");
        assert_eq!(decision["nonce"], 7);
    }

    #[test]
    #[should_panic(expected = "configured to fail")]
    fn mock_fail_always_panics() {
        mock().mock_fail();
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_the_next_answer() {
        let mut mock = mock();
        call_as("stranger.testnet", 0);

        mock.set_next(Mode::Null);
    }
}
