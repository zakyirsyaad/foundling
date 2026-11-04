use near_sdk::json_types::U128;
use near_sdk::{Gas, PromiseResult};

use crate::cycle::Stage;
use crate::swap::SwapStep;
use crate::tests::support::*;
use crate::tests::swap::{deposited, priced, swapped, USDC_UNIT, WNEAR_UNIT};
use crate::{Token, Vault};

const AMOUNT: u128 = 8 * USDC_UNIT;
const OUT: u128 = 18 * WNEAR_UNIT / 10;
const STUCK_AFTER: u64 = 600;
const HALT_AFTER: u64 = 3_600;

fn amount_reply(amount: u128) -> PromiseResult {
    PromiseResult::Successful(format!("\"{amount}\"").into_bytes())
}

fn held(usdc_amount: u128, wnear_amount: u128) -> Vec<PromiseResult> {
    vec![amount_reply(usdc_amount), amount_reply(wnear_amount)]
}

fn probe(vault: &mut Vault, attempt: u32, reply: Vec<PromiseResult>) {
    set_caller(alice());
    vault.advance(1);
    set_callback(reply);
    vault.on_probe(1, attempt);
}

fn stuck_on_deposit() -> Vault {
    let mut vault = priced("buy_risk", AMOUNT);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_deposited(1, 0);
    vault
}

fn stuck_on_partial_deposit(used: u128) -> Vault {
    let mut vault = priced("buy_risk", AMOUNT);
    set_callback(vec![PromiseResult::Successful(
        format!("\"{used}\"").into_bytes(),
    )]);
    vault.on_deposited(1, 0);
    vault
}

fn stuck_on_swap() -> Vault {
    let mut vault = deposited(AMOUNT);
    set_callback(vec![PromiseResult::Successful(b"not json".to_vec())]);
    vault.on_swapped(1, 0);
    vault
}

fn withdraw_returns(vault: &mut Vault, attempt: u32, delivered: u128) {
    set_callback(vec![PromiseResult::Successful(
        format!("\"{delivered}\"").into_bytes(),
    )]);
    vault.on_withdrawn(1, attempt);
}

fn stuck_on_withdraw(delivered: u128) -> Vault {
    let mut vault = swapped(AMOUNT, OUT);
    withdraw_returns(&mut vault, 0, delivered);
    vault
}

fn stage_is_stuck(vault: &Vault, step: SwapStep) -> bool {
    matches!(vault.stage(), Stage::Stuck { step: found, .. } if found == step)
}

fn assert_clean_idle(vault: &Vault) {
    assert_eq!(vault.stage(), Stage::Idle);
    assert!(vault.inflight().is_none());
    assert_eq!(vault.rhea_book().usdc, U128(0));
    assert_eq!(vault.rhea_book().wnear, U128(0));
}

#[test]
#[should_panic(expected = "NOT_STUCK")]
fn advance_does_nothing_for_an_idle_vault() {
    let mut vault = ready_vault();
    set_caller(alice());

    vault.advance(1);
}

#[test]
#[should_panic(expected = "NOT_STUCK")]
fn a_healthy_step_cannot_be_advanced() {
    let mut vault = priced("buy_risk", AMOUNT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER - 1);

    vault.advance(1);
}

#[test]
fn a_step_past_its_timer_can_be_advanced() {
    let mut vault = priced("buy_risk", AMOUNT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);

    vault.advance(1);

    assert!(matches!(
        vault.stage(),
        Stage::Probing {
            step: SwapStep::Deposit,
            attempt: 1,
            ..
        }
    ));
}

#[test]
fn each_timed_out_step_keeps_its_name() {
    let mut vault = deposited(AMOUNT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);
    vault.advance(1);
    assert!(matches!(
        vault.stage(),
        Stage::Probing {
            step: SwapStep::Swap,
            ..
        }
    ));
}

#[test]
fn a_timed_out_withdraw_keeps_its_name() {
    let mut vault = swapped(AMOUNT, OUT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);
    vault.advance(1);
    assert!(matches!(
        vault.stage(),
        Stage::Probing {
            step: SwapStep::Withdraw,
            ..
        }
    ));
}

#[test]
#[should_panic(expected = "NOT_STUCK")]
fn another_nonce_cannot_be_advanced() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());

    vault.advance(2);
}

#[test]
#[should_panic(expected = "LOW_GAS")]
fn advance_needs_gas_for_the_whole_way() {
    let mut vault = stuck_on_deposit();
    set_caller_with_gas(alice(), Gas::from_tgas(100));

    vault.advance(1);
}

#[test]
fn advance_reads_what_ref_holds_for_the_vault() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());

    vault.advance(1);

    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "get_deposit");
    assert_eq!(args["account_id"], vault_id().as_str());
}

#[test]
fn advance_asks_for_each_token_alone() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());

    vault.advance(1);

    let tokens: Vec<_> = calls_to(&rhea())
        .into_iter()
        .map(|(_, args, _)| args["token_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(tokens, [usdc().to_string(), wnear().to_string()]);
}

#[test]
fn a_reading_with_one_reply_stays_stuck() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());
    vault.advance(1);

    set_callback(vec![amount_reply(0)]);
    vault.on_probe(1, 1);

    assert!(matches!(vault.stage(), Stage::Stuck { .. }));
}

#[test]
fn one_failed_reading_of_two_stays_stuck() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());
    vault.advance(1);

    set_callback(vec![amount_reply(0), PromiseResult::Failed]);
    vault.on_probe(1, 1);

    assert!(matches!(vault.stage(), Stage::Stuck { .. }));
}

#[test]
#[should_panic(expected = "NOT_STUCK")]
fn two_advances_in_one_block_send_one_probe() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());
    vault.advance(1);
    set_caller(bob());

    vault.advance(1);
}

#[test]
fn a_late_probe_can_be_replaced() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());
    vault.advance(1);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);

    vault.advance(1);

    assert!(matches!(vault.stage(), Stage::Probing { attempt: 2, .. }));
}

#[test]
fn a_probe_of_an_old_attempt_changes_nothing() {
    let mut vault = stuck_on_deposit();
    set_caller(alice());
    vault.advance(1);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);
    vault.advance(1);
    set_callback(held(0, 0));

    vault.on_probe(1, 1);

    assert!(matches!(vault.stage(), Stage::Probing { attempt: 2, .. }));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
}

#[test]
fn a_failed_probe_goes_back_to_stuck_and_keeps_the_clock() {
    let mut vault = stuck_on_deposit();
    let Stage::Stuck { since, .. } = vault.stage() else {
        panic!("expected Stuck");
    };

    set_caller_at(alice(), START_SECONDS + 100);
    vault.advance(1);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_probe(1, 1);

    assert!(matches!(
        vault.stage(),
        Stage::Stuck { step: SwapStep::Deposit, attempt: 1, since: kept, .. } if kept == since
    ));
}

#[test]
fn a_garbage_probe_goes_back_to_stuck() {
    let mut vault = stuck_on_deposit();

    probe(
        &mut vault,
        1,
        vec![PromiseResult::Successful(b"not json".to_vec())],
    );

    assert!(stage_is_stuck(&vault, SwapStep::Deposit));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
}

#[test]
fn a_probe_without_both_tokens_goes_back_to_stuck() {
    let mut vault = stuck_on_deposit();
    let body = format!(r#"{{"{}":"0"}}"#, usdc());

    probe(
        &mut vault,
        1,
        vec![PromiseResult::Successful(body.into_bytes())],
    );

    assert!(stage_is_stuck(&vault, SwapStep::Deposit));
}

#[test]
fn a_failed_deposit_waits_for_the_probe() {
    let vault = stuck_on_deposit();

    assert!(stage_is_stuck(&vault, SwapStep::Deposit));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
}

#[test]
fn a_deposit_that_never_reached_ref_returns_to_the_book() {
    let mut vault = stuck_on_deposit();

    probe(&mut vault, 1, held(0, 0));

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
    assert!(logs_contain("swap_reverted"));
}

#[test]
fn a_failed_deposit_that_did_reach_ref_is_withdrawn() {
    let mut vault = stuck_on_deposit();

    probe(&mut vault, 1, held(AMOUNT, 0));

    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "withdraw");
    assert_eq!(args["token_id"], usdc().as_str());
    assert_eq!(args["amount"], AMOUNT.to_string());
    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            attempt: 1,
            unwinding: true,
            ..
        }
    ));
    assert_eq!(vault.rhea_book().usdc, U128(AMOUNT));

    withdraw_returns(&mut vault, 1, AMOUNT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn a_partial_deposit_withdraws_the_part_at_ref_and_counts_the_refund() {
    let mut vault = stuck_on_partial_deposit(5 * USDC_UNIT);

    probe(&mut vault, 1, held(5 * USDC_UNIT, 0));

    assert_eq!(call_to(&rhea()).1["amount"], (5 * USDC_UNIT).to_string());
    assert_eq!(vault.inflight().unwrap().recovered, U128(3 * USDC_UNIT));

    withdraw_returns(&mut vault, 1, 5 * USDC_UNIT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn a_donation_on_a_deposit_takes_only_what_was_sent() {
    let mut vault = stuck_on_deposit();

    probe(&mut vault, 1, held(AMOUNT + 1, 0));

    assert_eq!(call_to(&rhea()).1["amount"], AMOUNT.to_string());
    withdraw_returns(&mut vault, 1, AMOUNT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn the_other_token_is_ignored_during_a_deposit() {
    let mut vault = stuck_on_deposit();

    probe(&mut vault, 1, held(0, 1));

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn dust_cannot_block_a_deposit_that_never_arrived() {
    let mut vault = stuck_on_deposit();

    probe(&mut vault, 1, held(1, 1));
    withdraw_returns(&mut vault, 1, 1);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn a_swap_that_never_ran_is_unwound_not_repeated() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(AMOUNT, 0));

    let (method, args, _) = call_to(&rhea());
    assert_eq!(method, "withdraw");
    assert_eq!(args["token_id"], usdc().as_str());

    withdraw_returns(&mut vault, 1, AMOUNT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
    assert!(logs_contain("swap_reverted"));
}

#[test]
fn a_swap_that_ran_collects_its_output() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(0, OUT));

    let (_, args, _) = call_to(&rhea());
    assert_eq!(args["token_id"], wnear().as_str());
    assert_eq!(args["amount"], OUT.to_string());
    assert_eq!(vault.inflight().unwrap().amount_out, Some(U128(OUT)));
    assert_eq!(vault.rhea_book().usdc, U128(0));
    assert_eq!(vault.rhea_book().wnear, U128(OUT));

    withdraw_returns(&mut vault, 1, OUT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
    assert!(logs_contain("executed"));
}

#[test]
fn input_dust_does_not_hide_a_finished_swap() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(1, OUT));

    assert_eq!(call_to(&rhea()).1["token_id"], wnear().as_str());
    withdraw_returns(&mut vault, 1, OUT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn output_dust_joins_a_swap_whose_reply_was_lost() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(0, OUT + 1));

    assert_eq!(call_to(&rhea()).1["amount"], (OUT + 1).to_string());
    withdraw_returns(&mut vault, 1, OUT + 1);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT + 1));
}

#[test]
fn a_donated_input_unwinds_a_swap_that_did_run() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(AMOUNT, OUT));

    let (_, args, _) = call_to(&rhea());
    assert_eq!(args["token_id"], usdc().as_str());
    assert_eq!(args["amount"], AMOUNT.to_string());
    withdraw_returns(&mut vault, 1, AMOUNT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
    assert_eq!(vault.book().wnear, U128(0));
}

#[test]
fn output_dust_does_not_hide_a_swap_that_never_ran() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(AMOUNT + 1, 1));

    let (_, args, _) = call_to(&rhea());
    assert_eq!(args["token_id"], usdc().as_str());
    assert_eq!(args["amount"], AMOUNT.to_string());
    withdraw_returns(&mut vault, 1, AMOUNT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn output_under_the_minimum_is_not_a_finished_swap() {
    let mut vault = stuck_on_swap();
    let minimum = vault.inflight().unwrap().min_amount_out.0;

    probe(&mut vault, 1, held(0, minimum - 1));

    assert!(stage_is_stuck(&vault, SwapStep::Swap));
}

#[test]
fn an_empty_ref_after_a_swap_stays_stuck_with_no_loss_written() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(0, 0));

    assert!(stage_is_stuck(&vault, SwapStep::Swap));
    assert_eq!(vault.rhea_book().usdc, U128(AMOUNT));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
}

#[test]
fn a_part_of_the_input_at_ref_stays_stuck() {
    let mut vault = stuck_on_swap();

    probe(&mut vault, 1, held(AMOUNT - 1, 0));

    assert!(stage_is_stuck(&vault, SwapStep::Swap));
}

#[test]
fn a_withdraw_that_came_back_is_sent_again() {
    let mut vault = stuck_on_withdraw(0);

    probe(&mut vault, 1, held(0, OUT));

    assert_eq!(call_to(&rhea()).1["amount"], OUT.to_string());

    withdraw_returns(&mut vault, 1, OUT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
    assert!(logs_contain("executed"));
}

#[test]
fn a_withdraw_that_arrived_without_a_callback_is_credited() {
    let mut vault = swapped(AMOUNT, OUT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);
    vault.advance(1);
    set_callback(held(0, 0));

    vault.on_probe(1, 1);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn a_partial_withdraw_collects_the_rest() {
    let mut vault = stuck_on_withdraw(5);

    probe(&mut vault, 1, held(0, OUT - 5));

    assert_eq!(call_to(&rhea()).1["amount"], (OUT - 5).to_string());
    assert_eq!(vault.inflight().unwrap().recovered, U128(5));

    withdraw_returns(&mut vault, 1, OUT - 5);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn a_second_partial_withdraw_adds_up() {
    let mut vault = stuck_on_withdraw(5);
    probe(&mut vault, 1, held(0, OUT - 5));
    withdraw_returns(&mut vault, 1, 7);
    assert!(stage_is_stuck(&vault, SwapStep::Withdraw));

    probe(&mut vault, 2, held(0, OUT - 12));
    withdraw_returns(&mut vault, 2, OUT - 12);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn a_partial_withdraw_shares_the_whole_result_with_the_bucket() {
    let mut vault = swapped(AMOUNT, OUT);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    withdraw_returns(&mut vault, 0, 5);

    probe(&mut vault, 1, held(0, OUT - 5));
    withdraw_returns(&mut vault, 1, OUT - 5);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT / 2));
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    assert_eq!(call_to(&wnear()).1["amount"], (OUT / 2).to_string());
}

#[test]
fn a_redeem_while_stuck_keeps_its_claim() {
    let mut vault = stuck_on_deposit();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    probe(&mut vault, 1, held(0, 0));

    assert_eq!(vault.book().usdc, U128(40 * USDC_UNIT));
    set_caller_with_yocto(alice());
    vault.claim_bucket(1);
    assert_eq!(call_to(&usdc()).1["amount"], (4 * USDC_UNIT).to_string());
}

#[test]
fn a_donation_on_a_withdraw_takes_only_the_ledger() {
    let mut vault = stuck_on_withdraw(0);

    probe(&mut vault, 1, held(0, OUT + 1));

    assert_eq!(call_to(&rhea()).1["amount"], OUT.to_string());
    withdraw_returns(&mut vault, 1, OUT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn the_other_token_is_ignored_during_a_withdraw() {
    let mut vault = stuck_on_withdraw(0);

    probe(&mut vault, 1, held(1, OUT));

    assert_eq!(call_to(&rhea()).1["token_id"], wnear().as_str());
    withdraw_returns(&mut vault, 1, OUT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn an_unwound_withdraw_is_sent_again_in_the_input_token() {
    let mut vault = deposited(AMOUNT);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_swapped(1, 0);
    withdraw_returns(&mut vault, 0, 0);

    probe(&mut vault, 1, held(AMOUNT, 0));

    assert_eq!(call_to(&rhea()).1["token_id"], usdc().as_str());
    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            unwinding: true,
            ..
        }
    ));
}

#[test]
fn a_late_callback_of_the_old_attempt_changes_nothing() {
    let mut vault = stuck_on_withdraw(0);
    probe(&mut vault, 1, held(0, OUT));

    withdraw_returns(&mut vault, 0, OUT);

    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing { attempt: 1, .. }
    ));
    assert_eq!(vault.book().wnear, U128(0));
}

#[test]
fn a_frozen_vault_can_still_recover() {
    let mut vault = stuck_on_withdraw(0);
    set_caller(guardian());
    vault.freeze();

    probe(&mut vault, 1, held(0, OUT));
    withdraw_returns(&mut vault, 1, OUT);

    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
}

#[test]
fn a_short_stall_does_not_halt() {
    let mut vault = stuck_on_deposit();
    set_caller_at(alice(), START_SECONDS + HALT_AFTER - 1);

    vault.advance(1);

    assert!(!vault.is_halted());
}

#[test]
fn a_long_stall_halts_the_vault() {
    let mut vault = stuck_on_deposit();
    set_caller_at(alice(), START_SECONDS + HALT_AFTER);

    vault.advance(1);

    assert!(vault.is_halted());
    assert!(logs_contain("halted"));
}

#[test]
fn a_halted_vault_still_recovers_and_only_the_governor_clears_the_halt() {
    let mut vault = stuck_on_deposit();
    set_caller_at(alice(), START_SECONDS + HALT_AFTER);
    vault.advance(1);
    set_callback(held(0, 0));
    vault.on_probe(1, 1);

    assert_clean_idle(&vault);
    assert!(vault.is_halted());

    set_caller(governor());
    vault.clear_halt();
    assert!(!vault.is_halted());
}

#[test]
fn a_ledger_short_of_the_withdraw_is_stuck_not_hidden() {
    let mut vault = swapped(AMOUNT, OUT);
    vault.set_rhea_for_tests(Token::Wnear, OUT - 1);

    withdraw_returns(&mut vault, 0, OUT);

    assert!(stage_is_stuck(&vault, SwapStep::Withdraw));
    assert_eq!(vault.book().wnear, U128(0));
}

#[test]
fn a_ledger_short_of_the_swap_input_is_stuck_not_hidden() {
    let mut vault = deposited(AMOUNT);
    vault.set_rhea_for_tests(Token::Usdc, AMOUNT - 1);
    set_callback(vec![PromiseResult::Successful(
        format!("\"{OUT}\"").into_bytes(),
    )]);

    vault.on_swapped(1, 0);

    assert!(stage_is_stuck(&vault, SwapStep::Swap));
}

#[test]
fn stuck_keeps_the_attempt_of_the_failed_hop() {
    let mut vault = stuck_on_withdraw(0);
    probe(&mut vault, 1, held(0, OUT));

    withdraw_returns(&mut vault, 1, 0);

    assert!(matches!(vault.stage(), Stage::Stuck { attempt: 1, .. }));
}

#[test]
fn a_finished_swap_leaves_the_ledger_empty() {
    let mut vault = swapped(AMOUNT, OUT);

    withdraw_returns(&mut vault, 0, OUT);

    assert_clean_idle(&vault);
}

#[test]
fn a_swap_that_lands_after_the_unwind_began_collects_its_output() {
    let mut vault = deposited(AMOUNT);
    set_caller_at(alice(), START_SECONDS + STUCK_AFTER);
    vault.advance(1);
    set_callback(held(AMOUNT, 0));
    vault.on_probe(1, 1);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_withdrawn(1, 1);
    assert!(stage_is_stuck(&vault, SwapStep::Withdraw));

    probe(&mut vault, 2, held(0, OUT));

    assert_eq!(call_to(&rhea()).1["token_id"], wnear().as_str());
    assert!(matches!(
        vault.stage(),
        Stage::Withdrawing {
            unwinding: false,
            ..
        }
    ));
    withdraw_returns(&mut vault, 2, OUT);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().wnear, U128(OUT));
    assert_eq!(vault.book().usdc, U128(72 * USDC_UNIT));
    assert!(logs_contain("executed"));
}

#[test]
fn a_partial_unwind_ignores_the_other_token() {
    let mut vault = deposited(AMOUNT);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_swapped(1, 0);
    withdraw_returns(&mut vault, 0, 5);
    probe(&mut vault, 1, held(AMOUNT - 5, 0));
    withdraw_returns(&mut vault, 1, 0);

    probe(&mut vault, 2, held(AMOUNT - 5, OUT));

    assert_eq!(call_to(&rhea()).1["token_id"], usdc().as_str());
    withdraw_returns(&mut vault, 2, AMOUNT - 5);
    assert_clean_idle(&vault);
    assert_eq!(vault.book().usdc, U128(80 * USDC_UNIT));
}

#[test]
fn repeated_failures_do_not_restart_the_halt_clock() {
    let mut vault = stuck_on_withdraw(0);
    let later = START_SECONDS + 3_000;
    set_caller_at(alice(), later);
    vault.advance(1);
    set_callback_at(held(0, OUT), later);
    vault.on_probe(1, 1);
    set_callback_at(vec![PromiseResult::Successful(b"\"0\"".to_vec())], later);
    vault.on_withdrawn(1, 1);
    assert!(!vault.is_halted());
    set_caller_at(alice(), START_SECONDS + HALT_AFTER);

    vault.advance(1);

    assert!(vault.is_halted());
}

#[test]
fn a_timed_out_retry_does_not_restart_the_halt_clock() {
    let mut vault = stuck_on_withdraw(0);
    let later = START_SECONDS + 3_000;
    set_caller_at(alice(), later);
    vault.advance(1);
    set_callback_at(held(0, OUT), later);
    vault.on_probe(1, 1);
    set_caller_at(alice(), START_SECONDS + HALT_AFTER);

    vault.advance(1);

    assert!(vault.is_halted());
}
