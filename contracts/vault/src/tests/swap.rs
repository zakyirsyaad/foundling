use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{AccountId, NearToken, PromiseResult};

use crate::cycle::Stage;
use crate::math::mul_div;
use crate::swap::SwapStep;
use crate::tests::support::*;
use crate::{Token, Vault};

pub const USDC_UNIT: u128 = 1_000_000;
pub const WNEAR_UNIT: u128 = 1_000_000_000_000_000_000_000_000;
const NEAR_ID: &str = "near-id";
const USDC_ID: &str = "usdc-id";
const REF_PRICE: u128 = 450_000_000;

fn deposit(vault: &mut Vault, who: AccountId, amount: u128) {
    set_caller(usdc());
    assert_eq!(
        vault.ft_on_transfer(who, U128(amount), "deposit".to_string()),
        U128(0)
    );
}

fn decision(action: &str, amount: u128, ref_price: u128) -> Vec<u8> {
    json!({
        "v": 1, "vault": vault_id(), "chain": "testnet", "nonce": 1, "regime": "risk_on",
        "action": action, "amount_in": amount.to_string(), "ref_price": ref_price.to_string(),
        "commitment": COMMITMENT, "inputs_digest": "cc", "obs": {}, "ai_ref": {}, "wasm_hash": "bb",
    })
    .to_string()
    .into_bytes()
}

fn ready(action: &str, amount: u128) -> Vault {
    ready_at(action, amount, REF_PRICE)
}

fn ready_at(action: &str, amount: u128, ref_price: u128) -> Vault {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 40 * USDC_UNIT);
    deposit(&mut vault, bob(), 40 * USDC_UNIT);
    set_caller(keeper());
    vault.trigger_cycle();
    set_callback(vec![PromiseResult::Successful(decision(
        action, amount, ref_price,
    ))]);
    vault.on_decision(1);
    vault
}

fn executing(action: &str, amount: u128) -> Vault {
    let mut vault = ready(action, amount);
    set_caller(keeper());
    vault.execute_decision(1);
    vault
}

fn prices(near: &str, usdc: &str) -> Vec<PromiseResult> {
    let feed = |price: &str| json!({"price": price, "conf": "10000", "expo": -8, "publish_time": START_SECONDS - 30});
    let body = json!({ NEAR_ID: feed(near), USDC_ID: feed(usdc) });
    vec![PromiseResult::Successful(body.to_string().into_bytes())]
}

pub fn priced(action: &str, amount: u128) -> Vault {
    let mut vault = executing(action, amount);
    set_callback(prices("450000000", "100000000"));
    vault.on_price(1);
    vault
}

pub fn deposited(amount: u128) -> Vault {
    let mut vault = priced("buy_risk", amount);
    set_callback(vec![PromiseResult::Successful(
        format!("\"{amount}\"").into_bytes(),
    )]);
    vault.on_deposited(1, 0);
    vault
}

pub fn swapped(amount: u128, out: u128) -> Vault {
    let mut vault = deposited(amount);
    set_callback(vec![PromiseResult::Successful(
        format!("\"{out}\"").into_bytes(),
    )]);
    vault.on_swapped(1, 0);
    vault
}

fn withdrawn(vault: &mut Vault, value: &str) {
    set_callback(vec![PromiseResult::Successful(
        format!("\"{value}\"").into_bytes(),
    )]);
    vault.on_withdrawn(1, 0);
}

#[test]
fn execution_asks_the_oracle_with_the_policy_age() {
    let vault = executing("buy_risk", 8 * USDC_UNIT);

    let (method, args, _) = call_to(&oracle());
    assert_eq!(method, "list_prices_no_older_than");
    assert_eq!(args["age"], 120);
    assert_eq!(args["price_ids"][0], NEAR_ID);
    assert_eq!(args["price_ids"][1], USDC_ID);
    assert!(matches!(
        vault.stage(),
        Stage::AwaitingPrice { nonce: 1, .. }
    ));
}

#[test]
#[should_panic(expected = "NOT_KEEPER")]
fn only_the_keeper_executes() {
    let mut vault = ready("buy_risk", 8 * USDC_UNIT);
    set_caller(alice());
    vault.execute_decision(1);
}

#[test]
#[should_panic(expected = "NOT_READY")]
fn another_nonce_cannot_execute() {
    let mut vault = ready("buy_risk", 8 * USDC_UNIT);
    set_caller(keeper());
    vault.execute_decision(2);
}

#[test]
#[should_panic(expected = "FROZEN")]
fn a_frozen_vault_does_not_execute() {
    let mut vault = ready("buy_risk", 8 * USDC_UNIT);
    set_caller(guardian());
    vault.freeze();
    set_caller(keeper());
    vault.execute_decision(1);
}

#[test]
#[should_panic(expected = "EXPIRED")]
fn an_expired_decision_does_not_execute() {
    let mut vault = ready("buy_risk", 8 * USDC_UNIT);
    set_caller_at(keeper(), START_SECONDS + 600);
    vault.execute_decision(1);
}

#[test]
fn an_approved_buy_debits_the_book_and_pays_ref() {
    let vault = priced("buy_risk", 8 * USDC_UNIT);

    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
    assert!(matches!(
        vault.stage(),
        Stage::Depositing {
            nonce: 1,
            attempt: 0,
            ..
        }
    ));
    let (method, args, one_yocto) = call_to(&usdc());
    assert_eq!(method, "ft_transfer_call");
    assert_eq!(args["receiver_id"], rhea().as_str());
    assert_eq!(args["amount"], "8000000");
    assert_eq!(args["msg"], "");
    assert_eq!(one_yocto, NearToken::from_yoctonear(1));
}

#[test]
fn the_minimum_out_comes_from_the_anchor_not_the_agent() {
    let vault = priced("buy_risk", 8 * USDC_UNIT);

    let inflight = vault.inflight().unwrap();
    let expected =
        (8 * USDC_UNIT * 10u128.pow(18) * 100_000_000 * 9_850).div_ceil(450_000_000 * 10_000);
    assert_eq!(inflight.min_amount_out, U128(expected));
    assert_eq!(inflight.token_in, Token::Usdc);
    assert_eq!(inflight.token_out, Token::Wnear);
}

#[test]
fn an_unavailable_price_leaves_the_decision_ready() {
    let mut vault = executing("buy_risk", 8 * USDC_UNIT);
    let body = json!({ NEAR_ID: null, USDC_ID: null });
    set_callback(vec![PromiseResult::Successful(
        body.to_string().into_bytes(),
    )]);

    vault.on_price(1);

    assert!(matches!(
        vault.stage(),
        Stage::DecisionReady { nonce: 1, .. }
    ));
    assert!(logs_contain("PRICE_UNAVAILABLE"));
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn a_failed_oracle_call_leaves_the_decision_ready() {
    let mut vault = executing("buy_risk", 8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Failed]);

    vault.on_price(1);

    assert!(matches!(
        vault.stage(),
        Stage::DecisionReady { nonce: 1, .. }
    ));
}

#[test]
fn a_wide_price_ends_the_cycle() {
    let mut vault = executing("buy_risk", 8 * USDC_UNIT);
    let feed = json!({"price": "450000000", "conf": "9000000", "expo": -8, "publish_time": START_SECONDS - 30});
    let body = json!({ NEAR_ID: feed, USDC_ID: feed });
    set_callback(vec![PromiseResult::Successful(
        body.to_string().into_bytes(),
    )]);

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("PRICE_WIDE"));
}

#[test]
fn a_reference_far_from_the_anchor_ends_the_cycle() {
    let mut vault = ready_at("buy_risk", 8 * USDC_UNIT, 500_000_000);
    set_caller(keeper());
    vault.execute_decision(1);
    set_callback(prices("450000000", "100000000"));

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("PRICE_DEVIATION"));
}

#[test]
fn a_buy_over_the_cap_is_rejected_whole() {
    let mut vault = executing("buy_risk", 8 * USDC_UNIT + 1);
    set_callback(prices("450000000", "100000000"));

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("OVER_CAP"));
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn a_freeze_during_the_price_read_ends_the_cycle() {
    let mut vault = executing("buy_risk", 8 * USDC_UNIT);
    set_caller(guardian());
    vault.freeze();
    set_callback(prices("450000000", "100000000"));

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("FROZEN"));
}

#[test]
fn a_sell_uses_the_wnear_side() {
    let mut vault = ready("sell_risk", 4 * WNEAR_UNIT);
    vault.set_books_for_tests(80 * USDC_UNIT, 10 * WNEAR_UNIT);
    set_caller(keeper());
    vault.execute_decision(1);
    set_callback(prices("450000000", "100000000"));

    vault.on_price(1);

    assert_eq!(vault.book().wnear, U128(6 * WNEAR_UNIT));
    assert_eq!(call_to(&wnear()).0, "ft_transfer_call");
    assert_eq!(vault.inflight().unwrap().min_amount_out, U128(17_730_000));
}

#[test]
fn the_swap_start_says_what_was_sold() {
    priced("buy_risk", 8 * USDC_UNIT);

    assert!(logs_contain(r#""token_in":"Usdc""#));
    assert!(logs_contain(r#""amount_in":"8000000""#));
    assert!(logs_contain("min_amount_out"));
}

fn high_precision_prices(near: &str, usdc: &str) -> Vec<PromiseResult> {
    let feed = |price: &str| json!({"price": price, "conf": "1000000", "expo": -18, "publish_time": START_SECONDS - 30});
    let body = json!({ NEAR_ID: feed(near), USDC_ID: feed(usdc) });
    vec![PromiseResult::Successful(body.to_string().into_bytes())]
}

#[test]
fn a_high_precision_feed_still_prices_a_sell() {
    let mut vault = ready("sell_risk", 4 * WNEAR_UNIT);
    vault.set_books_for_tests(80 * USDC_UNIT, 10 * WNEAR_UNIT);
    set_caller(keeper());
    vault.execute_decision(1);
    set_callback(high_precision_prices(
        "4500000000000000000",
        "1000000000000000000",
    ));

    vault.on_price(1);

    assert_eq!(vault.inflight().unwrap().min_amount_out, U128(17_730_000));
}

#[test]
fn a_price_too_large_to_value_is_rejected_without_a_panic() {
    let huge = (i64::MAX as u128) * 100_000_000;
    let mut vault = ready_at("buy_risk", 8 * USDC_UNIT, huge);
    vault.set_books_for_tests(80 * USDC_UNIT, 10 * WNEAR_UNIT);
    set_caller(keeper());
    vault.execute_decision(1);
    let feed = |price: String| json!({"price": price, "conf": "0", "expo": -8, "publish_time": START_SECONDS - 30});
    let body = json!({ NEAR_ID: feed(i64::MAX.to_string()), USDC_ID: feed("1".to_string()) });
    set_callback(vec![PromiseResult::Successful(
        body.to_string().into_bytes(),
    )]);

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("PRICE_DEVIATION"));
}

#[test]
fn a_full_deposit_moves_on_to_the_swap() {
    let vault = deposited(8 * USDC_UNIT);

    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "swap");
    assert_eq!(args["actions"][0]["pool_id"], 4512);
    assert_eq!(args["actions"][0]["amount_in"], "8000000");
    assert_eq!(
        args["actions"][0]["min_amount_out"],
        vault.inflight().unwrap().min_amount_out.0.to_string()
    );
    assert!(matches!(vault.stage(), Stage::Swapping { nonce: 1, .. }));
}

#[test]
fn an_unused_deposit_returns_to_the_book() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Successful(b"\"0\"".to_vec())]);

    vault.on_deposited(1, 0);

    assert_eq!(vault.stage(), Stage::Idle);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
    assert!(vault.inflight().is_none());
}

#[test]
fn a_partial_deposit_is_stuck() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Successful(b"\"5\"".to_vec())]);

    vault.on_deposited(1, 0);

    assert!(matches!(
        vault.stage(),
        Stage::Stuck {
            step: SwapStep::Deposit,
            ..
        }
    ));
}

#[test]
fn a_freeze_before_the_swap_unwinds_it() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_caller(guardian());
    vault.freeze();
    set_callback(vec![PromiseResult::Successful(b"\"8000000\"".to_vec())]);

    vault.on_deposited(1, 0);

    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            unwinding: true,
            ..
        }
    ));
    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "withdraw");
    assert_eq!(args["token_id"], usdc().as_str());
}

#[test]
fn a_finished_swap_withdraws_the_output() {
    let vault = swapped(8 * USDC_UNIT, 17 * WNEAR_UNIT / 10);

    let (method, args, one_yocto) = call_to(&rhea());
    assert_eq!(method, "withdraw");
    assert_eq!(args["token_id"], wnear().as_str());
    assert_eq!(args["amount"], (17 * WNEAR_UNIT / 10).to_string());
    assert_eq!(args["skip_unwrap_near"], true);
    assert_eq!(one_yocto, NearToken::from_yoctonear(1));
    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            unwinding: false,
            ..
        }
    ));
}

#[test]
fn a_failed_swap_withdraws_the_input() {
    let mut vault = deposited(8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Failed]);

    vault.on_swapped(1, 0);

    let (_, args, _) = call_to(&rhea());
    assert_eq!(args["token_id"], usdc().as_str());
    assert_eq!(args["amount"], "8000000");
    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            unwinding: true,
            ..
        }
    ));
}

#[test]
fn an_unreadable_swap_result_is_stuck() {
    let mut vault = deposited(8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Successful(b"not json".to_vec())]);

    vault.on_swapped(1, 0);

    assert!(matches!(
        vault.stage(),
        Stage::Stuck {
            step: SwapStep::Swap,
            ..
        }
    ));
}

#[test]
fn a_finished_withdraw_credits_the_book() {
    let out = 17 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);

    withdrawn(&mut vault, &out.to_string());

    assert_eq!(vault.stage(), Stage::Idle);
    assert_eq!(vault.book().wnear, U128(out));
    assert!(vault.inflight().is_none());
    assert!(logs_contain("executed"));
}

#[test]
fn an_unwound_swap_credits_the_input() {
    let mut vault = deposited(8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_swapped(1, 0);

    withdrawn(&mut vault, "8000000");

    assert_eq!(vault.stage(), Stage::Idle);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
    assert!(logs_contain("swap_reverted"));
}

#[test]
fn a_zero_withdraw_is_stuck_and_credits_nothing() {
    let out = 17 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);

    withdrawn(&mut vault, "0");

    assert!(matches!(
        vault.stage(),
        Stage::Stuck {
            step: SwapStep::Withdraw,
            ..
        }
    ));
    assert_eq!(vault.book().wnear, U128(0));
}

#[test]
fn a_partial_withdraw_is_stuck_and_credits_nothing() {
    let out = 17 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);

    withdrawn(&mut vault, "5");

    assert!(matches!(
        vault.stage(),
        Stage::Stuck {
            step: SwapStep::Withdraw,
            ..
        }
    ));
    assert_eq!(vault.book().wnear, U128(0));
}

fn redeem_then_deposit_returns(result: PromiseResult) {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    set_callback(vec![result]);

    vault.on_deposited(1, 0);

    assert_eq!(vault.book().usdc, U128(40 * USDC_UNIT));
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    assert_eq!(call_to(&usdc()).1["amount"], (4 * USDC_UNIT).to_string());
}

#[test]
fn a_holder_who_redeems_before_an_unused_deposit_keeps_a_claim() {
    redeem_then_deposit_returns(PromiseResult::Successful(b"\"0\"".to_vec()));
}

#[test]
fn a_zero_swap_output_is_stuck_and_sends_no_withdraw() {
    let vault = swapped(8 * USDC_UNIT, 0);

    assert!(matches!(
        vault.stage(),
        Stage::Stuck {
            step: SwapStep::Swap,
            ..
        }
    ));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn a_huge_reference_price_ends_the_cycle_without_a_panic() {
    let mut vault = ready_at("buy_risk", 8 * USDC_UNIT, u128::MAX / 100);
    set_caller(keeper());
    vault.execute_decision(1);
    set_callback(prices("450000000", "100000000"));

    vault.on_price(1);

    assert_eq!(vault.stage(), Stage::Idle);
    assert!(logs_contain("PRICE_DEVIATION"));
}

#[test]
fn the_executed_event_reports_both_amounts() {
    let out = 17 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);

    withdrawn(&mut vault, &out.to_string());

    assert!(logs_contain(r#""amount_in":"8000000""#));
    assert!(logs_contain(&format!(r#""amount_out":"{out}""#)));
}

#[test]
fn a_callback_with_an_old_attempt_changes_nothing() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Successful(b"\"8000000\"".to_vec())]);

    vault.on_deposited(1, 3);

    assert!(matches!(vault.stage(), Stage::Depositing { .. }));
}

#[test]
fn a_callback_for_another_step_changes_nothing() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_callback(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);

    vault.on_swapped(1, 0);
    vault.on_withdrawn(1, 0);

    assert!(matches!(vault.stage(), Stage::Depositing { .. }));
}

#[test]
#[should_panic(expected = "NOT_IDLE")]
fn no_new_cycle_starts_during_a_swap() {
    let mut vault = priced("buy_risk", 8 * USDC_UNIT);
    set_caller_at(keeper(), START_SECONDS + 1_800);
    vault.trigger_cycle();
}

#[test]
fn turnover_counts_against_the_window() {
    let vault = priced("buy_risk", 8 * USDC_UNIT);

    assert_eq!(vault.window_used(Token::Usdc), U128(8 * USDC_UNIT));
}

#[test]
fn a_holder_who_redeems_mid_swap_keeps_a_claim_on_the_result() {
    let out = 16 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    withdrawn(&mut vault, &out.to_string());

    assert_eq!(vault.book().wnear, U128(out / 2));
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    assert_eq!(call_to(&wnear()).1["amount"], (out / 2).to_string());
}

#[test]
fn a_bucket_and_a_claim_can_be_read() {
    let out = 16 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);
    let shares = vault.shares_of(alice());
    assert_eq!(vault.bucket(1), None);
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    withdrawn(&mut vault, &out.to_string());

    assert_eq!(vault.bucket(1).unwrap().result, U128(out));
    assert_eq!(vault.bucket_claim(1, alice()), shares);
    assert_eq!(vault.bucket_claim(1, bob()), U128(0));
}

#[test]
fn a_redeem_after_the_swap_needs_no_bucket() {
    let out = 16 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);

    withdrawn(&mut vault, &out.to_string());

    assert_eq!(vault.book().wnear, U128(out));
}

#[test]
#[should_panic(expected = "bucket not resolved")]
fn a_bucket_cannot_be_claimed_before_the_swap_ends() {
    let mut vault = swapped(8 * USDC_UNIT, WNEAR_UNIT);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn a_bucket_pays_each_holder_once() {
    let out = 16 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    withdrawn(&mut vault, &out.to_string());
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn a_holder_who_stayed_has_no_bucket_claim() {
    let out = 16 * WNEAR_UNIT / 10;
    let mut vault = swapped(8 * USDC_UNIT, out);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    withdrawn(&mut vault, &out.to_string());
    set_caller_with_yocto(bob());
    vault.claim_bucket(1);
}

#[test]
fn claims_and_book_never_exceed_the_result() {
    let out = 7;
    let mut vault = swapped(8 * USDC_UNIT, out);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    withdrawn(&mut vault, &out.to_string());

    let reserved = out - vault.book().wnear.0;
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    let paid: u128 = call_to(&wnear()).1["amount"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(paid <= reserved);
}

/// Alice and Bob hold shares, and a swap at `nonce` has begun with nothing else in flight.
fn holders_mid_swap(nonce: u64) -> Vault {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 40 * USDC_UNIT);
    deposit(&mut vault, bob(), 40 * USDC_UNIT);
    vault.mint_pending();
    vault.begin_swap_for_tests(nonce);
    vault
}

fn redeem_part(vault: &mut Vault, who: AccountId, shares: u128) {
    set_caller_with_yocto(who);
    vault.redeem(U128(shares));
}

/// Alice redeemed a quarter during swap 1, which settled, and swap 2 has begun.
/// Returns what her claim on swap 1 is worth.
fn claim_left_from_swap_one(vault: &mut Vault) -> u128 {
    let quarter = vault.shares_of(alice()).0 / 4;
    redeem_part(vault, alice(), quarter);
    vault.settle_swap(1, Token::Wnear, 16 * WNEAR_UNIT / 10, false);
    let bucket = vault.bucket(1).unwrap();
    vault.begin_swap_for_tests(2);
    mul_div(bucket.result.0, quarter, bucket.snapshot.0)
}

#[test]
fn an_older_claim_folds_into_claimable_when_its_holder_redeems_in_the_next_swap() {
    let mut vault = holders_mid_swap(1);
    let owed = claim_left_from_swap_one(&mut vault);
    let quarter = vault.shares_of(alice()).0 / 3;

    redeem_part(&mut vault, alice(), quarter);

    assert_eq!(vault.bucket_claim(1, alice()), U128(0));
    assert_eq!(vault.claimable_of(alice(), Token::Wnear), U128(owed));
    assert_eq!(vault.bucket_claim(2, alice()), U128(quarter));
}

#[test]
fn a_folded_claim_takes_its_bucket_with_it() {
    let mut vault = holders_mid_swap(1);
    claim_left_from_swap_one(&mut vault);
    let quarter = vault.shares_of(alice()).0 / 3;

    redeem_part(&mut vault, alice(), quarter);

    assert_eq!(vault.bucket(1), None);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn a_folded_claim_cannot_be_claimed_again() {
    let mut vault = holders_mid_swap(1);
    claim_left_from_swap_one(&mut vault);
    let quarter = vault.shares_of(alice()).0 / 3;
    redeem_part(&mut vault, alice(), quarter);

    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
}

#[test]
fn a_bucket_stays_while_a_holder_has_not_claimed() {
    let mut vault = holders_mid_swap(1);
    let quarter = vault.shares_of(alice()).0 / 4;
    redeem_part(&mut vault, alice(), quarter);
    redeem_part(&mut vault, bob(), quarter);
    vault.settle_swap(1, Token::Wnear, 16 * WNEAR_UNIT / 10, false);

    set_caller_with_yocto(alice());
    vault.claim_bucket(1);

    assert!(vault.bucket(1).is_some());
}

#[test]
fn a_bucket_goes_once_every_holder_has_claimed() {
    let mut vault = holders_mid_swap(1);
    let quarter = vault.shares_of(alice()).0 / 4;
    redeem_part(&mut vault, alice(), quarter);
    redeem_part(&mut vault, bob(), quarter);
    vault.settle_swap(1, Token::Wnear, 16 * WNEAR_UNIT / 10, false);
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);

    set_caller_with_yocto(bob());
    vault.claim_bucket(1);

    assert_eq!(vault.bucket(1), None);
}
