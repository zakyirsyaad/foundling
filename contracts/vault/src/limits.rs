//! Trade limits. A decision that breaks one is rejected whole, never clamped.

use near_sdk::json_types::U128;
use near_sdk::near;

use crate::math::mul_div;
use crate::policy::Policy;

const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    OverCap,
    OverAbsCap,
    OverEpochCap,
    OverBook,
    ExposureLimit,
}

impl Reject {
    pub fn code(self) -> &'static str {
        match self {
            Self::OverCap => "OVER_CAP",
            Self::OverAbsCap => "OVER_ABS_CAP",
            Self::OverEpochCap => "OVER_EPOCH_CAP",
            Self::OverBook => "OVER_BOOK",
            Self::ExposureLimit => "EXPOSURE_LIMIT",
        }
    }
}

pub struct BuyContext {
    pub amount_in: u128,
    pub nav_usdc: u128,
    pub usdc_book: u128,
    pub wnear_value_usdc: u128,
    pub window_used: u128,
}

pub struct SellContext {
    pub amount_in: u128,
    pub wnear_book: u128,
    pub window_used: u128,
}

/// Checks run in the order bps, absolute, window, so a mock price shows which cap held.
pub fn check_buy(policy: &Policy, buy: &BuyContext) -> Result<(), Reject> {
    if buy.amount_in > of_bps(buy.nav_usdc, policy.cap_bps) {
        return Err(Reject::OverCap);
    }
    if buy.amount_in > policy.cap_usdc.0 {
        return Err(Reject::OverAbsCap);
    }
    let epoch_cap = of_bps(buy.nav_usdc, policy.epoch_cap_bps).min(policy.epoch_cap_usdc.0);
    if buy.window_used + buy.amount_in > epoch_cap {
        return Err(Reject::OverEpochCap);
    }
    let max_exposure = of_bps(buy.nav_usdc, policy.max_risk_bps);
    if buy.wnear_value_usdc + buy.amount_in > max_exposure {
        return Err(Reject::ExposureLimit);
    }
    if buy.amount_in > buy.usdc_book {
        return Err(Reject::OverBook);
    }
    Ok(())
}

/// A sell never needs a price: its caps are in wNEAR, so a mock price cannot widen them.
pub fn check_sell(policy: &Policy, sell: &SellContext) -> Result<(), Reject> {
    if sell.amount_in > sell_limit(policy, sell.wnear_book) {
        return Err(Reject::OverAbsCap);
    }
    if sell.window_used + sell.amount_in > policy.epoch_cap_wnear.0 {
        return Err(Reject::OverEpochCap);
    }
    if sell.amount_in > sell.wnear_book {
        return Err(Reject::OverBook);
    }
    Ok(())
}

/// A book at or under `cap_wnear` may be swept whole; halving forever would never reach flat.
fn sell_limit(policy: &Policy, wnear_book: u128) -> u128 {
    let cap_wnear = policy.cap_wnear.0;
    if wnear_book <= cap_wnear {
        return cap_wnear;
    }
    cap_wnear.min(of_bps(wnear_book, policy.cap_sell_bps))
}

fn of_bps(amount: u128, bps: u32) -> u128 {
    mul_div(amount, bps as u128, BPS)
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct WindowEntry {
    pub at: u64,
    pub amount: U128,
}

/// Rolling turnover, half open: an entry counts while `at > now - epoch_len`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Window {
    entries: Vec<WindowEntry>,
}

impl Window {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn used(&self, now: u64, epoch_len: u64) -> u128 {
        self.entries
            .iter()
            .filter(|entry| is_inside(entry, now, epoch_len))
            .map(|entry| entry.amount.0)
            .sum()
    }

    pub fn recorded(&self, at: u64, amount: u128) -> Self {
        let mut entries = self.entries.clone();
        entries.push(WindowEntry {
            at,
            amount: U128(amount),
        });
        Self { entries }
    }

    pub fn pruned(&self, now: u64, epoch_len: u64) -> Self {
        Self {
            entries: self
                .entries
                .iter()
                .filter(|entry| is_inside(entry, now, epoch_len))
                .cloned()
                .collect(),
        }
    }
}

fn is_inside(entry: &WindowEntry, now: u64, epoch_len: u64) -> bool {
    entry.at + epoch_len > now
}
