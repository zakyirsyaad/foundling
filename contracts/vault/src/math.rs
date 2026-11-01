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

/// Like `mul_div`, for values a feed controls: `None` instead of a panic in a callback.
pub fn try_mul_div(a: u128, b: u128, denominator: u128) -> Option<u128> {
    fit(U256::from(a) * U256::from(b) / U256::from(denominator))
}

/// The product of the `numerators` over the product of the `denominators`, rounded up.
pub fn try_ratio_ceil(numerators: &[u128], denominators: &[u128]) -> Option<u128> {
    let top = product(numerators)?;
    let bottom = product(denominators)?;
    if bottom.is_zero() {
        return None;
    }
    fit(top.checked_add(bottom - U256::one())? / bottom)
}

fn product(factors: &[u128]) -> Option<U256> {
    factors.iter().try_fold(U256::one(), |value, factor| {
        value.checked_mul(U256::from(*factor))
    })
}

fn fit(value: U256) -> Option<u128> {
    (value.bits() <= 128).then(|| value.as_u128())
}

/// `a·b ≤ c·d` for any u128, so comparing two ratios cannot overflow.
pub fn product_at_most(a: u128, b: u128, c: u128, d: u128) -> bool {
    U256::from(a) * U256::from(b) <= U256::from(c) * U256::from(d)
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
