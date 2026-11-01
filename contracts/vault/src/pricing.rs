//! The price anchor from the oracle. A swap bound never comes from the agent: it is
//! computed here, from prices the vault read itself in its own callback.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::{near, serde_json};

use crate::math::{mul_div, mul_div_ceil};

const BPS: u128 = 10_000;
/// `ref_price` is wNEAR in USDC with eight decimals.
const REF_PRICE_ONE: u128 = 100_000_000;
const MAX_CLOCK_LEAD: u64 = 5;

#[near(serializers = [json])]
struct Feed {
    price: U128,
    conf: U128,
    expo: i32,
    publish_time: u64,
}

pub struct PriceLimits<'a> {
    pub near_id: &'a str,
    pub usdc_id: &'a str,
    pub now: u64,
    pub max_age: u64,
    pub max_conf_bps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceReject {
    Unavailable,
    Stale,
    Wide,
    Deviation,
}

impl PriceReject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "PRICE_UNAVAILABLE",
            Self::Stale => "PRICE_STALE",
            Self::Wide => "PRICE_WIDE",
            Self::Deviation => "PRICE_DEVIATION",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub near: u128,
    pub usdc: u128,
}

pub fn read_anchor(bytes: &[u8], limits: &PriceLimits) -> Result<Anchor, PriceReject> {
    let mut feeds: BTreeMap<String, Option<Feed>> =
        serde_json::from_slice(bytes).map_err(|_| PriceReject::Unavailable)?;
    let near = feeds.remove(limits.near_id).flatten();
    let usdc = feeds.remove(limits.usdc_id).flatten();
    let (Some(near), Some(usdc)) = (near, usdc) else {
        return Err(PriceReject::Unavailable);
    };
    if near.price.0 == 0 || usdc.price.0 == 0 || near.expo != usdc.expo {
        return Err(PriceReject::Unavailable);
    }
    check_feed(&near, limits)?;
    check_feed(&usdc, limits)?;
    Ok(Anchor {
        near: near.price.0,
        usdc: usdc.price.0,
    })
}

fn check_feed(feed: &Feed, limits: &PriceLimits) -> Result<(), PriceReject> {
    let too_new = feed.publish_time > limits.now + MAX_CLOCK_LEAD;
    let too_old = feed.publish_time + limits.max_age < limits.now;
    if too_new || too_old {
        return Err(PriceReject::Stale);
    }
    if feed.conf.0 * BPS > feed.price.0 * limits.max_conf_bps as u128 {
        return Err(PriceReject::Wide);
    }
    Ok(())
}

impl Anchor {
    pub fn ref_price(&self) -> u128 {
        mul_div(self.near, REF_PRICE_ONE, self.usdc)
    }

    pub fn accepts_ref_price(&self, ref_price: u128, max_dev_bps: u32) -> bool {
        let anchor = self.ref_price();
        anchor.abs_diff(ref_price) * BPS <= anchor * max_dev_bps as u128
    }

    /// `scale` is 10^(wNEAR decimals - USDC decimals).
    pub fn wnear_value(&self, wnear: u128, scale: u128) -> u128 {
        mul_div(wnear, self.near, self.usdc) / scale
    }

    pub fn min_out_buy(&self, amount_in: u128, slippage_bps: u32, scale: u128) -> u128 {
        mul_div_ceil(
            amount_in * scale,
            self.usdc * (BPS - slippage_bps as u128),
            self.near * BPS,
        )
    }

    pub fn min_out_sell(&self, amount_in: u128, slippage_bps: u32, scale: u128) -> u128 {
        mul_div_ceil(
            amount_in,
            self.near * (BPS - slippage_bps as u128),
            self.usdc * scale * BPS,
        )
    }
}
