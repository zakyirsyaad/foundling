//! Share arithmetic. Every product of a book and a share count goes through U256.

use uint::construct_uint;

construct_uint! {
    struct U256(4);
}

/// Shares per unit of the first deposit, and the size of the virtual position.
pub const VIRTUAL_SHARES: u128 = 1_000_000;
const VIRTUAL_ASSETS: u128 = 1;

pub fn mul_div(a: u128, b: u128, denominator: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(denominator)).as_u128()
}

pub fn mul_div_ceil(a: u128, b: u128, denominator: u128) -> u128 {
    let denominator = U256::from(denominator);
    ((U256::from(a) * U256::from(b) + denominator - U256::one()) / denominator).as_u128()
}

/// Takes the lower of the offset price and the book price: the offset alone would
/// let a deposit after a gain buy below the redemption price and dilute old holders.
pub fn shares_for_deposit(amount: u128, total_shares: u128, nav: u128) -> u128 {
    let with_offset = mul_div(amount, total_shares + VIRTUAL_SHARES, nav + VIRTUAL_ASSETS);
    if total_shares == 0 || nav == 0 {
        return with_offset;
    }
    with_offset.min(mul_div(amount, total_shares, nav))
}

pub fn payout(book: u128, shares: u128, total_shares: u128) -> u128 {
    mul_div(book, shares, total_shares)
}
