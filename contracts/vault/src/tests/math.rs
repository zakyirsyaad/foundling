use proptest::prelude::*;

use crate::math::{mul_div, payout, shares_for_deposit, VIRTUAL_SHARES};

const MAX_ASSETS: u128 = 1_000_000_000_000;

#[test]
fn mul_div_rounds_down() {
    assert_eq!(mul_div(7, 3, 2), 10);
}

#[test]
fn mul_div_survives_a_product_above_u128() {
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
}

#[test]
fn first_deposit_uses_the_virtual_offset() {
    assert_eq!(shares_for_deposit(10, 0, 0), 10 * VIRTUAL_SHARES);
}

#[test]
fn deposit_after_a_gain_buys_fewer_shares() {
    let shares = shares_for_deposit(100, 1_000 * VIRTUAL_SHARES, 2_000);

    assert_eq!(shares, 50 * VIRTUAL_SHARES);
}

#[test]
fn deposit_into_a_worthless_vault_still_mints() {
    assert!(shares_for_deposit(100, 1_000, 0) > 0);
}

#[test]
fn dust_deposit_can_round_to_zero_shares() {
    assert_eq!(shares_for_deposit(1, 1, 1_000), 0);
}

#[test]
fn payout_is_pro_rata_and_rounds_down() {
    assert_eq!(payout(100, 1, 3), 33);
}

proptest! {
    /// I1: redeem(deposit(x)) never returns more than x, whatever the book did before.
    #[test]
    fn redeem_never_returns_more_than_the_deposit(
        seed in 1..MAX_ASSETS,
        gain in 0..MAX_ASSETS,
        deposit in 1..MAX_ASSETS,
    ) {
        let seed_shares = shares_for_deposit(seed, 0, 0);
        let nav = seed + gain;

        let minted = shares_for_deposit(deposit, seed_shares, nav);

        let back = payout(nav + deposit, minted, seed_shares + minted);
        prop_assert!(back <= deposit);
    }

    /// A later deposit never takes value from the holders already in the vault.
    #[test]
    fn old_holders_keep_their_share_of_the_book(
        seed in 1..MAX_ASSETS,
        gain in 0..MAX_ASSETS,
        deposit in 1..MAX_ASSETS,
    ) {
        let seed_shares = shares_for_deposit(seed, 0, 0);
        let nav = seed + gain;
        let before = payout(nav, seed_shares, seed_shares);

        let minted = shares_for_deposit(deposit, seed_shares, nav);

        let after = payout(nav + deposit, seed_shares, seed_shares + minted);
        prop_assert!(after >= before);
    }

    /// Every holder redeeming together cannot take more than the book holds.
    #[test]
    fn payouts_never_exceed_the_book(
        book in 0..MAX_ASSETS,
        first in 1..MAX_ASSETS,
        second in 1..MAX_ASSETS,
    ) {
        let total = first + second;

        let paid = payout(book, first, total) + payout(book, second, total);

        prop_assert!(paid <= book);
    }
}
