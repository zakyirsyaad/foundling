//! Fits a trade inside the vault's limits. The vault rejects a breach whole and never
//! clamps, so a fixed size could leave it unable to sell back to flat. These rules mirror
//! `contracts/vault/src/limits.rs`.

use serde::{Deserialize, Serialize};

use crate::{decimal, Input};

const BPS: u128 = 10_000;
/// `obs` prices are wNEAR in USDC with eight decimals.
const PRICE_ONE: u128 = 100_000_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Limits {
    pub cap_bps: u32,
    pub epoch_cap_bps: u32,
    pub max_risk_bps: u32,
    pub cap_sell_bps: u32,
    pub ref_dev_bps: u32,
    #[serde(with = "decimal")]
    pub cap_usdc: u128,
    #[serde(with = "decimal")]
    pub epoch_cap_usdc: u128,
    #[serde(with = "decimal")]
    pub cap_wnear: u128,
    #[serde(with = "decimal")]
    pub epoch_cap_wnear: u128,
    #[serde(with = "decimal")]
    pub decimal_scale: u128,
}

pub fn buy_room(input: &Input, price: u128) -> u128 {
    buy_limit(input, price).unwrap_or(0)
}

pub fn sell_room(input: &Input) -> u128 {
    sell_limit(input).unwrap_or(0)
}

/// The vault values wNEAR at its anchor, up to `ref_dev_bps` from `price` either way, so
/// NAV takes the low edge and exposure the high edge.
fn buy_limit(input: &Input, price: u128) -> Option<u128> {
    let limits = &input.limits;
    let value = input
        .wnear_book
        .checked_mul(price)?
        .checked_div(PRICE_ONE)?
        .checked_div(limits.decimal_scale)?;
    let band = limits.ref_dev_bps as u128;
    let low_value = of_bps(value, BPS.checked_sub(band)?)?;
    let high_value = of_bps(value, BPS.checked_add(band)?)?;
    let nav = input.usdc_book.checked_add(low_value)?;
    let cap = of_bps(nav, limits.cap_bps as u128)?.min(limits.cap_usdc);
    let epoch_cap = of_bps(nav, limits.epoch_cap_bps as u128)?.min(limits.epoch_cap_usdc);
    let max_exposure = of_bps(nav, limits.max_risk_bps as u128)?;
    Some(
        cap.min(epoch_cap.saturating_sub(input.window_buy))
            .min(max_exposure.saturating_sub(high_value))
            .min(input.usdc_book),
    )
}

fn sell_limit(input: &Input) -> Option<u128> {
    let limits = &input.limits;
    let book = input.wnear_book;
    let cap = if book <= limits.cap_wnear {
        limits.cap_wnear
    } else {
        limits
            .cap_wnear
            .min(of_bps(book, limits.cap_sell_bps as u128)?)
    };
    Some(
        cap.min(limits.epoch_cap_wnear.saturating_sub(input.window_sell))
            .min(book),
    )
}

fn of_bps(amount: u128, bps: u128) -> Option<u128> {
    amount.checked_mul(bps).map(|product| product / BPS)
}
