//! Vault policy. After `init` it can only tighten, and never past its floors.

use near_sdk::json_types::U128;
use near_sdk::near;

pub const NOT_TIGHTER: &str = "POLICY_NOT_TIGHTER";
pub const BELOW_FLOOR: &str = "POLICY_BELOW_FLOOR";

const CAP_FLOOR_DIVISOR: u128 = 10;
const OPS_BUDGET_FLOOR_DIVISOR: u128 = 4;
const COOLDOWN_CEILING_FACTOR: u64 = 4;
const MIN_DEPOSIT_CEILING_FACTOR: u128 = 5;
const SLIPPAGE_FLOOR_BPS: u32 = 50;
const PRICE_MAX_AGE_FLOOR: u64 = 30;
const PRICE_CONF_FLOOR_BPS: u32 = 10;
const REF_DEV_FLOOR_BPS: u32 = 50;
const MIN_MINT_PER_CYCLE: u32 = 1;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub cap_bps: u32,
    pub epoch_cap_bps: u32,
    pub cap_usdc: U128,
    pub epoch_cap_usdc: U128,
    pub cap_wnear: U128,
    pub epoch_cap_wnear: U128,
    pub cap_sell_bps: u32,
    pub dust_wnear: U128,
    pub max_risk_bps: u32,
    pub epoch_len: u64,
    pub cooldown: u64,
    pub slippage_bps: u32,
    pub price_max_age: u64,
    pub price_max_conf_bps: u32,
    pub ref_dev_bps: u32,
    pub decision_ttl: u64,
    pub abort_after_blocks: u64,
    pub stuck_after: u64,
    pub halt_after: u64,
    pub max_execution_seconds: u64,
    pub ops_budget: U128,
    pub near_reserve: U128,
    pub tvl_cap: U128,
    pub per_user_cap: U128,
    pub min_deposit: U128,
    pub max_mint_per_cycle: u32,
    pub timelock: u64,
}

/// Only what may tighten after `init`. Fixed parameters have no field here.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PolicyChange {
    pub cap_bps: Option<u32>,
    pub epoch_cap_bps: Option<u32>,
    pub cap_usdc: Option<U128>,
    pub epoch_cap_usdc: Option<U128>,
    pub cap_wnear: Option<U128>,
    pub epoch_cap_wnear: Option<U128>,
    pub cap_sell_bps: Option<u32>,
    pub dust_wnear: Option<U128>,
    pub max_risk_bps: Option<u32>,
    pub cooldown: Option<u64>,
    pub slippage_bps: Option<u32>,
    pub price_max_age: Option<u64>,
    pub price_max_conf_bps: Option<u32>,
    pub ref_dev_bps: Option<u32>,
    pub ops_budget: Option<U128>,
    pub tvl_cap: Option<U128>,
    pub per_user_cap: Option<U128>,
    pub min_deposit: Option<U128>,
    pub max_mint_per_cycle: Option<u32>,
}

impl Policy {
    /// Floors come from `initial`, so repeated small cuts cannot walk past them.
    pub fn tightened(
        &self,
        initial: &Policy,
        change: &PolicyChange,
    ) -> Result<Policy, &'static str> {
        if *change == PolicyChange::default() {
            return Err(NOT_TIGHTER);
        }
        Ok(Policy {
            cap_bps: lowered(self.cap_bps, change.cap_bps, bps_floor(initial.cap_bps))?,
            epoch_cap_bps: lowered(
                self.epoch_cap_bps,
                change.epoch_cap_bps,
                bps_floor(initial.epoch_cap_bps),
            )?,
            cap_usdc: lowered_amount(self.cap_usdc, change.cap_usdc, cap_floor(initial.cap_usdc))?,
            epoch_cap_usdc: lowered_amount(
                self.epoch_cap_usdc,
                change.epoch_cap_usdc,
                cap_floor(initial.epoch_cap_usdc),
            )?,
            cap_wnear: lowered_amount(
                self.cap_wnear,
                change.cap_wnear,
                cap_floor(initial.cap_wnear),
            )?,
            epoch_cap_wnear: lowered_amount(
                self.epoch_cap_wnear,
                change.epoch_cap_wnear,
                cap_floor(initial.epoch_cap_wnear),
            )?,
            cap_sell_bps: lowered(
                self.cap_sell_bps,
                change.cap_sell_bps,
                bps_floor(initial.cap_sell_bps),
            )?,
            dust_wnear: lowered_amount(self.dust_wnear, change.dust_wnear, 0)?,
            max_risk_bps: lowered(
                self.max_risk_bps,
                change.max_risk_bps,
                bps_floor(initial.max_risk_bps),
            )?,
            cooldown: raised(
                self.cooldown,
                change.cooldown,
                initial.cooldown * COOLDOWN_CEILING_FACTOR,
            )?,
            slippage_bps: lowered(self.slippage_bps, change.slippage_bps, SLIPPAGE_FLOOR_BPS)?,
            price_max_age: lowered(
                self.price_max_age,
                change.price_max_age,
                PRICE_MAX_AGE_FLOOR,
            )?,
            price_max_conf_bps: lowered(
                self.price_max_conf_bps,
                change.price_max_conf_bps,
                PRICE_CONF_FLOOR_BPS,
            )?,
            ref_dev_bps: lowered(self.ref_dev_bps, change.ref_dev_bps, REF_DEV_FLOOR_BPS)?,
            ops_budget: lowered_amount(
                self.ops_budget,
                change.ops_budget,
                initial.ops_budget.0 / OPS_BUDGET_FLOOR_DIVISOR,
            )?,
            tvl_cap: lowered_amount(self.tvl_cap, change.tvl_cap, cap_floor(initial.tvl_cap))?,
            per_user_cap: lowered_amount(
                self.per_user_cap,
                change.per_user_cap,
                cap_floor(initial.per_user_cap),
            )?,
            min_deposit: U128(raised(
                self.min_deposit.0,
                change.min_deposit.map(|amount| amount.0),
                initial.min_deposit.0 * MIN_DEPOSIT_CEILING_FACTOR,
            )?),
            max_mint_per_cycle: lowered(
                self.max_mint_per_cycle,
                change.max_mint_per_cycle,
                MIN_MINT_PER_CYCLE,
            )?,
            ..self.clone()
        })
    }
}

fn lowered<T: PartialOrd + Copy>(
    current: T,
    requested: Option<T>,
    floor: T,
) -> Result<T, &'static str> {
    let Some(value) = requested else {
        return Ok(current);
    };
    if value >= current {
        return Err(NOT_TIGHTER);
    }
    if value < floor {
        return Err(BELOW_FLOOR);
    }
    Ok(value)
}

fn raised<T: PartialOrd + Copy>(
    current: T,
    requested: Option<T>,
    ceiling: T,
) -> Result<T, &'static str> {
    let Some(value) = requested else {
        return Ok(current);
    };
    if value <= current {
        return Err(NOT_TIGHTER);
    }
    if value > ceiling {
        return Err(BELOW_FLOOR);
    }
    Ok(value)
}

fn lowered_amount(
    current: U128,
    requested: Option<U128>,
    floor: u128,
) -> Result<U128, &'static str> {
    lowered(current.0, requested.map(|amount| amount.0), floor).map(U128)
}

fn cap_floor(initial: U128) -> u128 {
    initial.0 / CAP_FLOOR_DIVISOR
}

fn bps_floor(initial: u32) -> u32 {
    initial / CAP_FLOOR_DIVISOR as u32
}
