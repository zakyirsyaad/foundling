use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{Gas, PromiseResult};

use crate::tests::support::*;
use crate::Vault;

fn with_pool(pool: serde_json::Value) -> Vec<PromiseResult> {
    let mut results = selftest_results();
    results[0] = PromiseResult::Successful(pool.to_string().into_bytes());
    results
}

fn with_decimals(index: usize, decimals: u8) -> Vec<PromiseResult> {
    let mut results = selftest_results();
    results[index] =
        PromiseResult::Successful(json!({ "decimals": decimals }).to_string().into_bytes());
    results
}

fn run(results: Vec<PromiseResult>) -> Vault {
    let mut vault = set_up_vault();
    set_caller(alice());
    vault.selftest();
    set_callback(results);
    vault.on_selftest();
    vault
}

fn deposit_returns(vault: &mut Vault, amount: u128) -> U128 {
    set_caller(usdc());
    vault.ft_on_transfer(alice(), U128(amount), "deposit".to_string())
}

#[test]
fn it_reads_the_pool_the_feeds_and_both_tokens() {
    let mut vault = set_up_vault();
    set_caller(alice());

    vault.selftest();

    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "get_pool");
    assert_eq!(args["pool_id"], 4512);
    let (method, args, _) = call_to(&oracle());
    assert_eq!(method, "list_prices_no_older_than");
    assert_eq!(args["age"], 120);
    assert_eq!(call_to(&usdc()).0, "ft_metadata");
    assert_eq!(call_to(&wnear()).0, "ft_metadata");
}

#[test]
#[should_panic(expected = "LOW_GAS")]
fn it_needs_enough_gas_for_every_view() {
    let mut vault = set_up_vault();
    set_caller_with_gas(alice(), Gas::from_tgas(50));

    vault.selftest();
}

#[test]
fn a_matching_config_passes() {
    let vault = run(selftest_results());

    assert!(vault.selftest_passed());
    assert!(logs_contain(r#""passed":true"#));
}

#[test]
fn a_pool_with_another_token_fails() {
    let vault = run(with_pool(json!({
        "token_account_ids": [usdc(), "other.near"], "total_fee": 30,
    })));

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_POOL"));
}

#[test]
fn a_pool_with_a_third_token_fails() {
    let vault = run(with_pool(json!({
        "token_account_ids": [usdc(), wnear(), "other.near"], "total_fee": 30,
    })));

    assert!(logs_contain("SELFTEST_POOL"));
    assert!(!vault.selftest_passed());
}

#[test]
fn a_pool_with_the_same_token_twice_fails() {
    let vault = run(with_pool(json!({
        "token_account_ids": [usdc(), usdc()], "total_fee": 30,
    })));

    assert!(logs_contain("SELFTEST_POOL"));
    assert!(!vault.selftest_passed());
}

#[test]
fn a_pool_in_the_other_order_passes() {
    let vault = run(with_pool(json!({
        "token_account_ids": [wnear(), usdc()], "total_fee": 30,
    })));

    assert!(vault.selftest_passed());
}

#[test]
fn another_pool_fee_fails() {
    let vault = run(with_pool(json!({
        "token_account_ids": [usdc(), wnear()], "total_fee": 5,
    })));

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_FEE"));
}

#[test]
fn a_null_feed_fails_with_the_price_code() {
    let mut results = selftest_results();
    let body = json!({ "near-id": null, "usdc-id": null }).to_string();
    results[1] = PromiseResult::Successful(body.into_bytes());

    let vault = run(results);

    assert!(!vault.selftest_passed());
    assert!(logs_contain("PRICE_UNAVAILABLE"));
}

#[test]
fn wrong_usdc_decimals_fail() {
    let vault = run(with_decimals(2, 24));

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_DECIMALS"));
}

#[test]
fn wrong_wnear_decimals_fail() {
    let vault = run(with_decimals(3, 18));

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_DECIMALS"));
}

#[test]
fn a_failed_view_fails_the_test() {
    let mut results = selftest_results();
    results[0] = PromiseResult::Failed;

    let vault = run(results);

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_POOL"));
}

#[test]
fn a_garbage_reply_fails_the_test() {
    let mut results = selftest_results();
    results[3] = PromiseResult::Successful(b"not json".to_vec());

    let vault = run(results);

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_DECIMALS"));
}

#[test]
fn a_missing_result_fails_the_test() {
    let mut results = selftest_results();
    results.pop();

    let vault = run(results);

    assert!(!vault.selftest_passed());
    assert!(logs_contain("SELFTEST_RESULTS"));
}

#[test]
fn a_failed_run_can_be_repeated() {
    let mut vault = run(with_decimals(2, 24));
    set_caller(alice());
    vault.selftest();
    set_callback(selftest_results());

    vault.on_selftest();

    assert!(vault.selftest_passed());
}

#[test]
#[should_panic(expected = "selftest already passed")]
fn a_passed_test_cannot_run_again() {
    let mut vault = run(selftest_results());
    set_caller(alice());

    vault.selftest();
}

#[test]
fn a_pass_survives_a_late_failing_callback() {
    let mut vault = run(selftest_results());
    set_callback(with_decimals(2, 24));

    vault.on_selftest();

    assert!(vault.selftest_passed());
}

#[test]
fn deposits_wait_for_the_selftest() {
    let mut vault = set_up_vault();

    assert_eq!(deposit_returns(&mut vault, 5_000_000), U128(5_000_000));
}

#[test]
fn deposits_open_after_the_selftest() {
    let mut vault = run(selftest_results());

    assert_eq!(deposit_returns(&mut vault, 5_000_000), U128(0));
}
