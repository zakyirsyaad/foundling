use near_sdk::json_types::U128;

use crate::policy::{Policy, PolicyChange, BELOW_FLOOR, NOT_TIGHTER};

pub fn demo_policy() -> Policy {
    Policy {
        cap_bps: 1_000,
        epoch_cap_bps: 2_000,
        cap_usdc: U128(15_000_000),
        epoch_cap_usdc: U128(30_000_000),
        cap_wnear: U128(4 * 10u128.pow(24)),
        epoch_cap_wnear: U128(8 * 10u128.pow(24)),
        cap_sell_bps: 5_000,
        dust_wnear: U128(10u128.pow(22)),
        max_risk_bps: 5_000,
        epoch_len: 21_600,
        cooldown: 1_800,
        slippage_bps: 150,
        price_max_age: 120,
        price_max_conf_bps: 50,
        ref_dev_bps: 200,
        decision_ttl: 600,
        abort_after_blocks: 450,
        stuck_after: 600,
        halt_after: 3_600,
        max_execution_seconds: 45,
        ops_budget: U128(6 * 10u128.pow(23)),
        near_reserve: U128(3 * 10u128.pow(23)),
        tvl_cap: U128(100_000_000),
        per_user_cap: U128(50_000_000),
        min_deposit: U128(1_000_000),
        max_mint_per_cycle: 8,
        timelock: 86_400,
    }
}

fn tighten(change: PolicyChange) -> Result<Policy, &'static str> {
    let policy = demo_policy();
    policy.tightened(&policy, &change)
}

#[test]
fn a_cap_can_go_down() {
    let tightened = tighten(PolicyChange {
        cap_usdc: Some(U128(10_000_000)),
        ..Default::default()
    });

    assert_eq!(tightened.unwrap().cap_usdc, U128(10_000_000));
}

#[test]
fn tightening_returns_a_copy_and_leaves_the_rest_alone() {
    let policy = demo_policy();

    let tightened = policy
        .tightened(
            &policy,
            &PolicyChange {
                price_max_age: Some(60),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(policy.price_max_age, 120);
    assert_eq!(tightened.price_max_age, 60);
    assert_eq!(tightened.cap_usdc, policy.cap_usdc);
}

#[test]
fn a_cap_cannot_go_up() {
    let result = tighten(PolicyChange {
        cap_usdc: Some(U128(15_000_001)),
        ..Default::default()
    });

    assert_eq!(result.unwrap_err(), NOT_TIGHTER);
}

#[test]
fn a_cap_cannot_go_below_ten_percent_of_its_start() {
    let result = tighten(PolicyChange {
        cap_usdc: Some(U128(1_499_999)),
        ..Default::default()
    });

    assert_eq!(result.unwrap_err(), BELOW_FLOOR);
}

#[test]
fn the_floor_uses_the_start_value_not_the_current_one() {
    let start = demo_policy();
    let once = start
        .tightened(
            &start,
            &PolicyChange {
                cap_usdc: Some(U128(2_000_000)),
                ..Default::default()
            },
        )
        .unwrap();

    let twice = once.tightened(
        &start,
        &PolicyChange {
            cap_usdc: Some(U128(1_500_000)),
            ..Default::default()
        },
    );

    assert_eq!(twice.unwrap().cap_usdc, U128(1_500_000));
}

#[test]
fn cooldown_only_goes_up_and_stops_at_four_times() {
    let up = tighten(PolicyChange {
        cooldown: Some(7_200),
        ..Default::default()
    });
    let down = tighten(PolicyChange {
        cooldown: Some(1_799),
        ..Default::default()
    });
    let too_far = tighten(PolicyChange {
        cooldown: Some(7_201),
        ..Default::default()
    });

    assert_eq!(up.unwrap().cooldown, 7_200);
    assert_eq!(down.unwrap_err(), NOT_TIGHTER);
    assert_eq!(too_far.unwrap_err(), BELOW_FLOOR);
}

#[test]
fn min_deposit_only_goes_up_and_stops_at_five_times() {
    let too_far = tighten(PolicyChange {
        min_deposit: Some(U128(5_000_001)),
        ..Default::default()
    });

    assert_eq!(too_far.unwrap_err(), BELOW_FLOOR);
}

#[test]
fn each_fixed_floor_holds() {
    let cases = [
        PolicyChange {
            slippage_bps: Some(49),
            ..Default::default()
        },
        PolicyChange {
            price_max_age: Some(29),
            ..Default::default()
        },
        PolicyChange {
            price_max_conf_bps: Some(9),
            ..Default::default()
        },
        PolicyChange {
            ref_dev_bps: Some(49),
            ..Default::default()
        },
    ];

    for change in cases {
        assert_eq!(tighten(change).unwrap_err(), BELOW_FLOOR);
    }
}

#[test]
fn ops_budget_stops_at_a_quarter_of_its_start() {
    let ok = tighten(PolicyChange {
        ops_budget: Some(U128(15 * 10u128.pow(22))),
        ..Default::default()
    });
    let too_far = tighten(PolicyChange {
        ops_budget: Some(U128(15 * 10u128.pow(22) - 1)),
        ..Default::default()
    });

    assert!(ok.is_ok());
    assert_eq!(too_far.unwrap_err(), BELOW_FLOOR);
}

#[test]
fn an_empty_change_is_refused() {
    assert_eq!(tighten(PolicyChange::default()).unwrap_err(), NOT_TIGHTER);
}

#[test]
fn the_same_value_is_not_a_tightening() {
    let result = tighten(PolicyChange {
        cap_usdc: Some(U128(15_000_000)),
        ..Default::default()
    });

    assert_eq!(result.unwrap_err(), NOT_TIGHTER);
}
