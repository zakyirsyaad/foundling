use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, get_created_receipts};
use near_sdk::{NearToken, PromiseResult};

use crate::setup::SetupTarget;
use crate::tests::support::*;
use crate::Token;

const USDC_UNIT: u128 = 1_000_000;

fn deposit(vault: &mut crate::Vault, who: near_sdk::AccountId, amount: u128) -> U128 {
    set_caller(usdc());
    vault.ft_on_transfer(who, U128(amount), "deposit".to_string())
}

fn answer_with_null(vault: &mut crate::Vault) {
    set_callback(vec![PromiseResult::Successful(b"null".to_vec())]);
    vault.on_decision(vault.last_nonce());
}

fn vault_with_shares() -> crate::Vault {
    let mut vault = ready_vault();
    assert_eq!(deposit(&mut vault, alice(), 10 * USDC_UNIT), U128(0));
    assert_eq!(deposit(&mut vault, bob(), 30 * USDC_UNIT), U128(0));
    set_caller(keeper());
    vault.trigger_cycle();
    vault
}

#[test]
fn a_deposit_waits_in_the_queue() {
    let mut vault = ready_vault();

    let unused = deposit(&mut vault, alice(), 10 * USDC_UNIT);

    assert_eq!(unused, U128(0));
    assert_eq!(vault.pending_of(alice()), U128(10 * USDC_UNIT));
    assert_eq!(vault.shares_of(alice()), U128(0));
    assert_eq!(vault.book().usdc, U128(0));
}

#[test]
fn a_second_deposit_adds_to_the_same_entry() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);

    deposit(&mut vault, alice(), 5 * USDC_UNIT);

    assert_eq!(vault.pending_of(alice()), U128(15 * USDC_UNIT));
}

#[test]
fn a_foreign_token_is_handed_back() {
    let mut vault = ready_vault();
    set_caller(wnear());

    let unused = vault.ft_on_transfer(alice(), U128(5), "deposit".to_string());

    assert_eq!(unused, U128(5));
    assert_eq!(vault.pending_of(alice()), U128(0));
}

#[test]
fn a_wrong_message_is_handed_back() {
    let mut vault = ready_vault();
    set_caller(usdc());

    let unused = vault.ft_on_transfer(alice(), U128(10 * USDC_UNIT), "other".to_string());

    assert_eq!(unused, U128(10 * USDC_UNIT));
}

#[test]
fn a_frozen_vault_hands_a_deposit_back() {
    let mut vault = ready_vault();
    set_caller(guardian());
    vault.freeze();

    assert_eq!(deposit(&mut vault, alice(), USDC_UNIT), U128(USDC_UNIT));
}

#[test]
fn a_halted_vault_hands_a_deposit_back() {
    let mut vault = ready_vault();
    vault.set_halted_for_tests(true);

    assert_eq!(deposit(&mut vault, alice(), USDC_UNIT), U128(USDC_UNIT));
}

#[test]
fn a_vault_without_storage_setup_hands_a_deposit_back() {
    let mut vault = new_vault();

    assert_eq!(deposit(&mut vault, alice(), USDC_UNIT), U128(USDC_UNIT));
}

#[test]
fn an_unlisted_depositor_is_handed_back() {
    let mut vault = ready_vault();

    assert_eq!(deposit(&mut vault, accounts(5), USDC_UNIT), U128(USDC_UNIT));
}

#[test]
fn a_deposit_under_the_minimum_is_handed_back() {
    let mut vault = ready_vault();

    assert_eq!(
        deposit(&mut vault, alice(), USDC_UNIT - 1),
        U128(USDC_UNIT - 1)
    );
}

#[test]
fn a_deposit_over_the_user_cap_is_handed_back() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 50 * USDC_UNIT);

    assert_eq!(deposit(&mut vault, alice(), 1), U128(1));
}

#[test]
fn a_deposit_over_the_tvl_cap_is_handed_back() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 50 * USDC_UNIT);
    deposit(&mut vault, bob(), 50 * USDC_UNIT);
    set_caller(governor());
    vault.add_depositor(accounts(5));

    assert_eq!(deposit(&mut vault, accounts(5), USDC_UNIT), U128(USDC_UNIT));
}

#[test]
fn cancelling_returns_the_queued_deposit() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    set_caller_with_yocto(alice());

    vault.cancel_deposit();

    assert_eq!(vault.pending_of(alice()), U128(0));
    let (method, args, one_yocto) = call_to(&usdc());
    assert_eq!(method, "ft_transfer");
    assert_eq!(one_yocto, NearToken::from_yoctonear(1));
    assert_eq!(args["receiver_id"], alice().as_str());
    assert_eq!(args["amount"], "10000000");
}

#[test]
fn cancelling_frees_the_caps() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 50 * USDC_UNIT);
    set_caller_with_yocto(alice());
    vault.cancel_deposit();

    assert_eq!(deposit(&mut vault, alice(), 50 * USDC_UNIT), U128(0));
}

#[test]
#[should_panic(expected = "nothing pending")]
fn cancelling_without_a_deposit_panics() {
    let mut vault = ready_vault();
    set_caller_with_yocto(alice());
    vault.cancel_deposit();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn cancelling_needs_one_yocto() {
    let mut vault = ready_vault();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    set_caller(alice());
    vault.cancel_deposit();
}

#[test]
fn cancelling_after_redeeming_every_share_still_works() {
    let mut vault = vault_with_shares();
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    set_caller_with_yocto(alice());
    vault.cancel_deposit();

    assert_eq!(vault.pending_of(alice()), U128(0));
    assert_eq!(vault.net_deposit_of(alice()), U128(0));
}

#[test]
fn redeeming_does_not_free_the_cap_held_by_the_queue() {
    let mut vault = vault_with_shares();
    deposit(&mut vault, alice(), 40 * USDC_UNIT);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    assert_eq!(vault.net_deposit_of(alice()), U128(40 * USDC_UNIT));
    assert_eq!(
        deposit(&mut vault, alice(), 10 * USDC_UNIT + 1),
        U128(10 * USDC_UNIT + 1)
    );
    assert_eq!(deposit(&mut vault, alice(), 10 * USDC_UNIT), U128(0));
}

#[test]
fn a_vault_under_its_near_reserve_hands_a_deposit_back() {
    let mut vault = ready_vault();
    set_caller_with_balance(usdc(), NearToken::from_millinear(100));

    let unused = vault.ft_on_transfer(alice(), U128(USDC_UNIT), "deposit".to_string());

    assert_eq!(unused, U128(USDC_UNIT));
}

#[test]
fn a_flat_vault_mints_the_queue_at_the_book_price() {
    let vault = vault_with_shares();

    assert_eq!(vault.pending_of(alice()), U128(0));
    assert!(vault.shares_of(alice()).0 > 0);
    assert_eq!(vault.shares_of(bob()).0, vault.shares_of(alice()).0 * 3);
    assert_eq!(vault.book().usdc, U128(40 * USDC_UNIT));
}

#[test]
fn minting_stops_at_the_limit_per_cycle() {
    let mut vault = ready_vault();
    vault.set_max_mint_for_tests(1);
    deposit(&mut vault, alice(), 10 * USDC_UNIT);
    deposit(&mut vault, bob(), 10 * USDC_UNIT);

    set_caller(keeper());
    vault.trigger_cycle();

    let queued = vault.pending_of(alice()).0 + vault.pending_of(bob()).0;
    assert_eq!(queued, 10 * USDC_UNIT);
}

#[test]
fn a_vault_holding_wnear_does_not_mint() {
    let mut vault = ready_vault();
    vault.set_books_for_tests(0, 10u128.pow(24));
    deposit(&mut vault, alice(), 10 * USDC_UNIT);

    set_caller(keeper());
    vault.trigger_cycle();

    assert_eq!(vault.pending_of(alice()), U128(10 * USDC_UNIT));
}

#[test]
#[should_panic(expected = "NOT_KEEPER")]
fn only_the_keeper_triggers() {
    let mut vault = ready_vault();
    set_caller(alice());
    vault.trigger_cycle();
}

#[test]
#[should_panic(expected = "FROZEN")]
fn a_frozen_vault_does_not_trigger() {
    let mut vault = ready_vault();
    set_caller(guardian());
    vault.freeze();
    set_caller(keeper());
    vault.trigger_cycle();
}

#[test]
#[should_panic(expected = "HALTED")]
fn a_halted_vault_does_not_trigger() {
    let mut vault = ready_vault();
    vault.set_halted_for_tests(true);
    set_caller(keeper());
    vault.trigger_cycle();
}

#[test]
#[should_panic(expected = "COOLDOWN")]
fn triggers_respect_the_cooldown() {
    let mut vault = ready_vault();
    set_caller(keeper());
    vault.trigger_cycle();
    answer_with_null(&mut vault);
    set_caller_at(keeper(), START_SECONDS + 1_799);
    vault.trigger_cycle();
}

#[test]
fn a_trigger_after_the_cooldown_passes() {
    let mut vault = ready_vault();
    set_caller(keeper());
    vault.trigger_cycle();
    answer_with_null(&mut vault);
    set_caller_at(keeper(), START_SECONDS + 1_800);
    vault.trigger_cycle();
}

#[test]
fn redeem_pays_each_token_pro_rata() {
    let mut vault = vault_with_shares();
    vault.set_books_for_tests(40 * USDC_UNIT, 8 * 10u128.pow(24));
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());

    vault.redeem(shares);

    assert_eq!(vault.shares_of(alice()), U128(0));
    assert_eq!(vault.book().usdc, U128(30 * USDC_UNIT));
    assert_eq!(vault.book().wnear, U128(6 * 10u128.pow(24)));
    assert_eq!(call_to(&usdc()).1["amount"], "10000000");
    assert_eq!(
        call_to(&wnear()).1["amount"],
        (2 * 10u128.pow(24)).to_string()
    );
}

#[test]
fn redeem_works_while_frozen() {
    let mut vault = vault_with_shares();
    set_caller(guardian());
    vault.freeze();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());

    vault.redeem(shares);

    assert_eq!(vault.shares_of(alice()), U128(0));
}

#[test]
fn redeem_works_while_halted() {
    let mut vault = vault_with_shares();
    vault.set_halted_for_tests(true);
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());

    vault.redeem(shares);

    assert_eq!(vault.shares_of(alice()), U128(0));
}

#[test]
fn redeem_lowers_the_net_deposit_by_its_share() {
    let mut vault = vault_with_shares();
    let half = U128(vault.shares_of(alice()).0 / 2);
    set_caller_with_yocto(alice());

    vault.redeem(half);

    assert_eq!(vault.net_deposit_of(alice()), U128(5 * USDC_UNIT));
}

#[test]
#[should_panic(expected = "not enough shares")]
fn redeem_cannot_take_more_than_the_balance() {
    let mut vault = vault_with_shares();
    let too_many = U128(vault.shares_of(alice()).0 + 1);
    set_caller_with_yocto(alice());
    vault.redeem(too_many);
}

#[test]
#[should_panic(expected = "nothing to pay")]
fn redeem_with_a_zero_payout_reverts() {
    let mut vault = vault_with_shares();
    set_caller_with_yocto(alice());
    vault.redeem(U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn redeem_needs_one_yocto() {
    let mut vault = vault_with_shares();
    let shares = vault.shares_of(alice());
    set_caller(alice());
    vault.redeem(shares);
}

#[test]
fn a_failed_transfer_becomes_claimable() {
    let mut vault = vault_with_shares();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    set_callback(vec![PromiseResult::Failed]);
    vault.on_xfer(alice(), Token::Usdc, U128(10 * USDC_UNIT));

    assert_eq!(
        vault.claimable_of(alice(), Token::Usdc),
        U128(10 * USDC_UNIT)
    );
}

#[test]
fn a_finished_transfer_leaves_nothing_claimable() {
    let mut vault = vault_with_shares();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);

    set_callback(vec![PromiseResult::Successful(Vec::new())]);
    vault.on_xfer(alice(), Token::Usdc, U128(10 * USDC_UNIT));

    assert_eq!(vault.claimable_of(alice(), Token::Usdc), U128(0));
}

#[test]
fn claimable_can_be_withdrawn_once() {
    let mut vault = vault_with_shares();
    let shares = vault.shares_of(alice());
    set_caller_with_yocto(alice());
    vault.redeem(shares);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_xfer(alice(), Token::Usdc, U128(10 * USDC_UNIT));

    set_caller_with_yocto(alice());
    vault.withdraw_claimable(Token::Usdc);

    assert_eq!(vault.claimable_of(alice(), Token::Usdc), U128(0));
    assert_eq!(call_to(&usdc()).1["amount"], "10000000");
}

#[test]
#[should_panic(expected = "nothing claimable")]
fn withdrawing_with_nothing_claimable_panics() {
    let mut vault = vault_with_shares();
    set_caller_with_yocto(alice());
    vault.withdraw_claimable(Token::Usdc);
}

#[test]
fn a_donation_leaves_the_book_alone() {
    let mut vault = vault_with_shares();
    let book = vault.book().usdc;

    set_caller(usdc());
    let unused = vault.ft_on_transfer(accounts(5), U128(USDC_UNIT), "deposit".to_string());

    assert_eq!(unused, U128(USDC_UNIT));
    assert_eq!(vault.book().usdc, book);
}

#[test]
fn storage_setup_runs_once_per_target() {
    let mut vault = new_vault();
    set_caller(accounts(5));

    vault.setup_storage(SetupTarget::Usdc);

    let (method, args, deposit) = call_to(&usdc());
    assert_eq!(method, "storage_deposit");
    assert_eq!(args["registration_only"], true);
    assert_eq!(
        deposit,
        NearToken::from_yoctonear(1_250_000_000_000_000_000_000)
    );
    assert!(!vault.is_setup_done());
}

#[test]
#[should_panic(expected = "setup already started")]
fn storage_setup_cannot_run_twice() {
    let mut vault = new_vault();
    set_caller(accounts(5));
    vault.setup_storage(SetupTarget::Usdc);
    set_caller(accounts(5));
    vault.setup_storage(SetupTarget::Usdc);
}

#[test]
fn a_failed_storage_setup_can_be_retried() {
    let mut vault = new_vault();
    set_caller(accounts(5));
    vault.setup_storage(SetupTarget::Usdc);
    set_callback(vec![PromiseResult::Failed]);
    vault.on_setup(SetupTarget::Usdc);

    set_caller(accounts(5));
    vault.setup_storage(SetupTarget::Usdc);
}

#[test]
#[should_panic(expected = "Ref storage first")]
fn ref_tokens_need_ref_storage_first() {
    let mut vault = new_vault();
    set_caller(accounts(5));
    vault.setup_storage(SetupTarget::RheaTokens);
}

#[test]
fn every_target_done_opens_deposits() {
    let vault = ready_vault();

    assert!(vault.is_setup_done());
}

#[test]
fn ref_storage_keeps_the_token_balance_usable() {
    let mut vault = new_vault();
    finish_setup(&mut vault, SetupTarget::Rhea);
    set_caller(accounts(5));

    vault.setup_storage(SetupTarget::RheaTokens);

    let (method, args, deposit) = call_to(&rhea());
    assert_eq!(method, "register_tokens");
    assert_eq!(args["token_ids"][0], usdc().as_str());
    assert_eq!(deposit, NearToken::from_yoctonear(1));
    assert!(get_created_receipts().len() >= 2);
}
