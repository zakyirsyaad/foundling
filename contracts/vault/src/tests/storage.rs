use near_sdk::json_types::U128;
use near_sdk::{env, testing_env, AccountId, NearToken};

use crate::policy::PolicyChange;
use crate::storage::REGISTRATION_FEE;
use crate::tests::support::*;
use crate::{Token, Vault};

const USDC_UNIT: u128 = 1_000_000;

fn carol() -> AccountId {
    "carol.near".parse().unwrap()
}

/// The longest account id NEAR allows, so the fee is measured against the largest keys.
fn longest_account() -> AccountId {
    format!("{}.near", "d".repeat(59)).parse().unwrap()
}

fn pay(who: AccountId, amount: NearToken) {
    let mut ctx = context(who, 0);
    ctx.attached_deposit(amount);
    testing_env!(ctx.build());
}

fn deposit(vault: &mut Vault, who: AccountId, amount: u128) -> U128 {
    set_caller(usdc());
    vault.ft_on_transfer(who, U128(amount), "deposit".to_string())
}

fn open_vault() -> Vault {
    let mut config = init_config();
    config.policy.open_deposits = true;
    ready_vault_from(config)
}

/// Bytes this call adds once the collections are written out; a mint frees the queue entry.
fn measured(vault: &mut Vault, call: impl FnOnce(&mut Vault)) -> i64 {
    let start = env::storage_usage();
    call(vault);
    vault.flush_for_tests();
    env::storage_usage() as i64 - start as i64
}

#[test]
fn an_unregistered_account_gets_its_deposit_back() {
    let mut config = init_config();
    config.allowlist.push(carol());
    let mut vault = ready_vault_from(config);

    let unused = deposit(&mut vault, carol(), 10 * USDC_UNIT);

    assert_eq!(unused, U128(10 * USDC_UNIT));
    assert_eq!(vault.pending_of(carol()), U128(0));
}

#[test]
fn a_registered_account_on_the_allowlist_can_deposit() {
    let mut config = init_config();
    config.allowlist.push(carol());
    let mut vault = ready_vault_from(config);
    register(&mut vault, carol());

    let unused = deposit(&mut vault, carol(), 10 * USDC_UNIT);

    assert_eq!(unused, U128(0));
    assert_eq!(vault.pending_of(carol()), U128(10 * USDC_UNIT));
}

#[test]
fn an_open_vault_takes_a_deposit_from_a_registered_stranger() {
    let mut vault = open_vault();
    register(&mut vault, carol());

    let unused = deposit(&mut vault, carol(), 10 * USDC_UNIT);

    assert_eq!(unused, U128(0));
    assert_eq!(vault.pending_of(carol()), U128(10 * USDC_UNIT));
}

#[test]
fn an_open_vault_hands_an_unregistered_stranger_its_deposit_back() {
    let mut vault = open_vault();

    assert_eq!(
        deposit(&mut vault, carol(), 10 * USDC_UNIT),
        U128(10 * USDC_UNIT)
    );
}

#[test]
fn a_closed_vault_hands_a_registered_stranger_its_deposit_back() {
    let mut vault = ready_vault();
    register(&mut vault, carol());

    assert_eq!(
        deposit(&mut vault, carol(), 10 * USDC_UNIT),
        U128(10 * USDC_UNIT)
    );
}

#[test]
fn closing_deposits_hands_a_registered_stranger_its_deposit_back() {
    let mut vault = open_vault();
    register(&mut vault, carol());
    set_caller(governor());
    vault.tighten_policy(PolicyChange {
        open_deposits: Some(false),
        ..Default::default()
    });

    assert_eq!(
        deposit(&mut vault, carol(), 10 * USDC_UNIT),
        U128(10 * USDC_UNIT)
    );
}

#[test]
fn an_open_vault_allows_anyone() {
    let vault = open_vault();

    assert!(vault.is_allowed(carol()));
}

#[test]
fn a_closed_vault_allows_only_its_list() {
    let vault = ready_vault();

    assert!(vault.is_allowed(alice()));
    assert!(!vault.is_allowed(carol()));
}

#[test]
fn registration_records_the_fee_as_the_balance() {
    let mut vault = ready_vault();
    pay(carol(), REGISTRATION_FEE);

    let balance = vault.storage_deposit(None, None);

    assert_eq!(balance.total, U128(REGISTRATION_FEE.as_yoctonear()));
    assert_eq!(balance.available, U128(0));
    assert_eq!(vault.storage_balance_of(carol()), Some(balance));
    assert!(logs_contain("storage_registered"));
}

#[test]
fn a_payer_can_register_another_account() {
    let mut vault = ready_vault();
    pay(alice(), REGISTRATION_FEE);

    vault.storage_deposit(Some(carol()), None);

    assert!(vault.storage_balance_of(carol()).is_some());
}

#[test]
fn an_account_has_no_balance_before_registration() {
    let vault = ready_vault();

    assert_eq!(vault.storage_balance_of(carol()), None);
}

#[test]
#[should_panic(expected = "attach exactly the registration fee")]
fn registration_below_the_fee_panics() {
    let mut vault = ready_vault();
    pay(
        carol(),
        NearToken::from_yoctonear(REGISTRATION_FEE.as_yoctonear() - 1),
    );

    vault.storage_deposit(None, None);
}

/// Panicking hands the whole attachment back, so the vault never needs to send NEAR.
#[test]
#[should_panic(expected = "attach exactly the registration fee")]
fn registration_above_the_fee_panics() {
    let mut vault = ready_vault();
    pay(
        carol(),
        NearToken::from_yoctonear(REGISTRATION_FEE.as_yoctonear() + 1),
    );

    vault.storage_deposit(None, None);
}

#[test]
#[should_panic(expected = "already registered")]
fn a_second_registration_panics() {
    let mut vault = ready_vault();
    register(&mut vault, carol());
    pay(carol(), REGISTRATION_FEE);

    vault.storage_deposit(None, None);
}

#[test]
fn the_bounds_are_the_fee_both_ways() {
    let vault = ready_vault();

    let bounds = vault.storage_balance_bounds();

    assert_eq!(bounds.min, U128(REGISTRATION_FEE.as_yoctonear()));
    assert_eq!(bounds.max, Some(U128(REGISTRATION_FEE.as_yoctonear())));
}

#[test]
fn withdrawing_nothing_returns_the_balance() {
    let mut vault = ready_vault();
    register(&mut vault, carol());
    set_caller_with_yocto(carol());

    let balance = vault.storage_withdraw(None);

    assert_eq!(balance.total, U128(REGISTRATION_FEE.as_yoctonear()));
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdrawing_storage_panics() {
    let mut vault = ready_vault();
    register(&mut vault, carol());
    set_caller_with_yocto(carol());

    vault.storage_withdraw(Some(U128(1)));
}

#[test]
#[should_panic(expected = "registration is permanent")]
fn unregistering_panics() {
    let mut vault = ready_vault();
    register(&mut vault, carol());
    set_caller_with_yocto(carol());

    vault.storage_unregister(None);
}

#[test]
fn unregistering_an_unknown_account_returns_false() {
    let mut vault = ready_vault();
    set_caller_with_yocto(carol());

    assert!(!vault.storage_unregister(None));
}

#[test]
fn a_queued_deposit_can_still_be_cancelled_after_closing() {
    let mut vault = open_vault();
    register(&mut vault, carol());
    deposit(&mut vault, carol(), 10 * USDC_UNIT);
    set_caller(governor());
    vault.tighten_policy(PolicyChange {
        open_deposits: Some(false),
        ..Default::default()
    });
    set_caller_with_yocto(carol());

    vault.cancel_deposit();

    assert_eq!(vault.pending_of(carol()), U128(0));
}

/// Every entry a depositor can hold at once, written by the longest account id there is:
/// registration, queue, net deposit, shares, both claim slots, one open bucket claim with
/// its index, and the bucket that claim keeps alive.
#[test]
fn the_fee_covers_every_entry_a_depositor_can_hold() {
    let account = longest_account();
    let mut vault = open_vault();
    let mut bytes = 0;

    pay(account.clone(), REGISTRATION_FEE);
    bytes += measured(&mut vault, |vault| {
        vault.storage_deposit(None, None);
    });
    set_caller(usdc());
    bytes += measured(&mut vault, |vault| {
        vault.ft_on_transfer(account.clone(), U128(10 * USDC_UNIT), "deposit".to_string());
    });
    bytes += measured(&mut vault, |vault| vault.mint_pending());
    bytes += measured(&mut vault, |vault| {
        vault.ft_on_transfer(account.clone(), U128(USDC_UNIT), "deposit".to_string());
    });
    vault.set_books_for_tests(10 * USDC_UNIT, 10u128.pow(24));
    set_caller_with_yocto(account.clone());
    let half = vault.shares_of(account.clone()).0 / 2;
    bytes += measured(&mut vault, |vault| vault.redeem(U128(half)));
    vault.begin_swap_for_tests(1);
    set_caller_with_yocto(account.clone());
    let quarter = vault.shares_of(account).0 / 2;
    bytes += measured(&mut vault, |vault| vault.redeem(U128(quarter)));
    bytes += measured(&mut vault, |vault| {
        vault.settle_swap(1, Token::Wnear, 10u128.pow(24), false);
    });

    // Exact, so any new per-account entry fails here and the fee is weighed again.
    assert_eq!(bytes, 1_165);
    let cost = u128::try_from(bytes).unwrap() * env::storage_byte_cost().as_yoctonear();
    assert!(
        cost <= REGISTRATION_FEE.as_yoctonear(),
        "{bytes} bytes cost {cost} yocto"
    );
}
