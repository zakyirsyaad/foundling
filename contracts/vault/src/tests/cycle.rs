use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, Gas, NearToken, PromiseResult};

use crate::cycle::Stage;
use crate::tests::support::*;
use crate::Vault;

const USDC_UNIT: u128 = 1_000_000;

fn deposit(vault: &mut Vault, who: AccountId, amount: u128) {
    set_caller(usdc());
    assert_eq!(
        vault.ft_on_transfer(who, U128(amount), "deposit".to_string()),
        U128(0)
    );
}

fn triggered_vault() -> Vault {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    set_caller(keeper());
    vault.trigger_cycle();
    vault
}

fn decision(nonce: u64, action: &str) -> Vec<u8> {
    json!({
        "v": 1,
        "vault": vault_id(),
        "chain": "testnet",
        "nonce": nonce,
        "regime": "risk_on",
        "action": action,
        "amount_in": "1000000",
        "ref_price": "450000000",
        "commitment": COMMITMENT,
        "inputs_digest": "cc",
        "obs": {},
        "ai_ref": {},
        "wasm_hash": "bb",
    })
    .to_string()
    .into_bytes()
}

fn answer(vault: &mut Vault, nonce: u64, result: PromiseResult) {
    set_callback(vec![result]);
    vault.on_decision(nonce);
}

#[test]
fn a_new_vault_is_idle() {
    assert_eq!(new_vault().stage(), Stage::Idle);
}

#[test]
fn a_trigger_asks_outlayer_from_the_vault_balance() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    set_caller(keeper());

    vault.trigger_cycle();

    let (method, args, attached) = call_to(&outlayer());
    assert_eq!(method, "request_execution");
    assert_eq!(attached, NearToken::from_millinear(50));
    assert_eq!(args["source"]["WasmUrl"]["hash"], "bb");
    assert_eq!(args["source"]["WasmUrl"]["build_target"], "wasm32-wasip2");
    assert_eq!(args["resource_limits"]["max_execution_seconds"], 45);
    assert_eq!(args["response_format"], "Json");
    assert_eq!(args["payer_account_id"], vault_id().as_str());
    assert_eq!(args["secrets_ref"]["profile"], "sp2");
    assert_eq!(args["secrets_ref"]["account_id"], "owner-secrets.near");
}

#[test]
fn the_resource_limits_come_from_the_sealed_config() {
    triggered_vault();

    let (_, args, _) = call_to(&outlayer());
    assert_eq!(
        args["resource_limits"]["max_instructions"],
        2_000_000_000u64
    );
    assert_eq!(args["resource_limits"]["max_memory_mb"], 256);
}

#[test]
fn the_input_carries_the_nonce_and_the_books() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    set_caller(keeper());

    vault.trigger_cycle();

    let (_, args, _) = call_to(&outlayer());
    let input: serde_json::Value =
        serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["v"], 1);
    assert_eq!(input["vault"], vault_id().as_str());
    assert_eq!(input["nonce"], 1);
    assert_eq!(input["usdc_book"], "10000000");
    assert_eq!(input["wnear_book"], "0");
}

#[test]
fn the_input_matches_the_fixture_the_strategy_reads() {
    triggered_vault();

    let (_, args, _) = call_to(&outlayer());
    let input: serde_json::Value =
        serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../strategy/fixtures/input.json")).unwrap();
    assert_eq!(input, fixture);
}

#[test]
fn an_accepted_decision_is_published_whole() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    assert!(logs_contain(r#""event":"decision""#));
    assert!(logs_contain("inputs_digest"));
}

#[test]
fn a_hold_is_published_whole() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "none")),
    );

    assert!(logs_contain(r#""event":"decision""#));
    assert!(logs_contain("inputs_digest"));
}

#[test]
fn a_refused_answer_is_not_published() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(9, "none")),
    );

    assert!(!logs_contain(r#""event":"decision""#));
}

#[test]
fn the_nonce_is_stored_before_the_answer() {
    let vault = triggered_vault();

    assert!(matches!(
        vault.stage(),
        Stage::AwaitingDecision { nonce: 1, .. }
    ));
    assert_eq!(vault.last_nonce(), 1);
}

#[test]
#[should_panic(expected = "NOT_IDLE")]
fn a_second_trigger_waits_for_the_first() {
    let mut vault = triggered_vault();
    set_caller_at(keeper(), START_SECONDS + 1_800);
    vault.trigger_cycle();
}

#[test]
#[should_panic(expected = "LOW_GAS")]
fn a_trigger_needs_its_gas() {
    let mut vault = ready_vault();
    set_caller_with_gas(keeper(), Gas::from_tgas(200));
    vault.trigger_cycle();
}

#[test]
fn a_trigger_counts_against_the_ops_budget() {
    let vault = triggered_vault();

    assert_eq!(vault.ops_spent(), U128(50_000_000_000_000_000_000_000));
}

#[test]
#[should_panic(expected = "OPS_BUDGET")]
fn the_ops_budget_stops_a_trigger() {
    let mut vault = ready_vault();
    vault.set_ops_spent_for_tests(6 * 10u128.pow(23));
    set_caller(keeper());
    vault.trigger_cycle();
}

#[test]
#[should_panic(expected = "NEAR_RESERVE")]
fn the_near_floor_stops_a_trigger() {
    let mut vault = ready_vault();
    set_caller_with_balance(keeper(), NearToken::from_millinear(100));
    vault.trigger_cycle();
}

#[test]
fn a_valid_decision_waits_for_execution() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    assert!(matches!(
        vault.stage(),
        Stage::DecisionReady { nonce: 1, .. }
    ));
    assert!(logs_contain("decision_ready"));
}

#[test]
fn the_contract_sets_the_expiry() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    let Stage::DecisionReady { expires_at, .. } = vault.stage() else {
        panic!("expected DecisionReady");
    };
    assert_eq!(expires_at, START_SECONDS + 600);
}

#[test]
fn no_action_goes_back_to_idle() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "none")),
    );

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("hold"));
}

#[test]
fn null_goes_back_to_idle() {
    let mut vault = triggered_vault();

    answer(&mut vault, 1, PromiseResult::Successful(b"null".to_vec()));

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("NULL_RESULT"));
}

#[test]
fn a_failed_request_goes_back_to_idle() {
    let mut vault = triggered_vault();

    answer(&mut vault, 1, PromiseResult::Failed);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("REQUEST_FAILED"));
}

#[test]
fn a_wrong_nonce_inside_the_decision_goes_back_to_idle() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(9, "buy_risk")),
    );

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("NONCE_MISMATCH"));
}

#[test]
fn a_late_callback_for_another_nonce_changes_nothing() {
    let mut vault = triggered_vault();

    answer(
        &mut vault,
        9,
        PromiseResult::Successful(decision(9, "buy_risk")),
    );

    assert!(matches!(
        vault.stage(),
        Stage::AwaitingDecision { nonce: 1, .. }
    ));
}

#[test]
fn a_callback_while_idle_changes_nothing() {
    let mut vault = ready_vault();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    assert_eq!(vault.stage(), Stage::Idle);
}

#[test]
fn a_freeze_during_the_wait_discards_the_decision() {
    let mut vault = triggered_vault();
    set_caller(guardian());
    vault.freeze();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    assert_eq!(vault.stage(), Stage::Idle);
}

#[test]
fn the_outlayer_answer_never_panics_without_a_result() {
    let mut vault = triggered_vault();
    set_callback(Vec::new());

    vault.on_decision(1);

    assert_eq!(vault.stage(), Stage::Idle);
}

#[test]
fn a_silent_cycle_can_be_aborted_by_anyone() {
    let mut vault = triggered_vault();
    set_caller_at_block(alice(), 451);

    vault.abort_stale_cycle();

    assert_eq!(vault.stage(), Stage::Idle);
}

#[test]
#[should_panic(expected = "NOT_STALE")]
fn a_cycle_cannot_be_aborted_early() {
    let mut vault = triggered_vault();
    set_caller_at_block(alice(), 449);
    vault.abort_stale_cycle();
}

#[test]
#[should_panic(expected = "NOT_AWAITING")]
fn aborting_needs_a_waiting_cycle() {
    let mut vault = ready_vault();
    set_caller(alice());
    vault.abort_stale_cycle();
}

#[test]
fn an_answer_after_an_abort_changes_nothing() {
    let mut vault = triggered_vault();
    set_caller_at_block(alice(), 451);
    vault.abort_stale_cycle();

    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );

    assert_eq!(vault.stage(), Stage::Idle);
}

#[test]
fn an_expired_decision_can_be_dropped_by_anyone() {
    let mut vault = triggered_vault();
    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );
    set_caller_at(alice(), START_SECONDS + 600);

    vault.expire_decision();

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("EXPIRED"));
}

#[test]
#[should_panic(expected = "NOT_EXPIRED")]
fn a_live_decision_cannot_be_dropped() {
    let mut vault = triggered_vault();
    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "buy_risk")),
    );
    set_caller_at(alice(), START_SECONDS + 599);
    vault.expire_decision();
}

#[test]
fn a_deposit_is_not_minted_while_a_cycle_runs() {
    let mut vault = triggered_vault();
    deposit(&mut vault, bob(), 10 * USDC_UNIT);
    answer(
        &mut vault,
        1,
        PromiseResult::Successful(decision(1, "none")),
    );

    assert_eq!(vault.pending_of(bob()), U128(10 * USDC_UNIT));
}

#[test]
fn redeem_works_while_a_cycle_waits() {
    let mut vault = triggered_vault();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());

    vault.redeem(shares);

    assert_eq!(vault.shares_of(alice()), U128(0));
}
