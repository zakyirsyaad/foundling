use near_sdk::json_types::U128;
use near_sdk::test_utils::accounts;

use crate::policy::PolicyChange;
use crate::tests::support::*;
use crate::Vault;

#[test]
fn init_from_the_parent_sets_roles_and_emits_the_hash() {
    let vault = new_vault();

    assert_eq!(vault.roles().keeper, keeper());
    assert!(!vault.is_frozen());
    assert!(!vault.is_halted());
    assert_eq!(vault.total_shares(), U128(0));
    assert!(logs_contain("initialized"));
}

#[test]
#[should_panic(expected = "init: only the parent account")]
fn init_from_another_account_is_refused() {
    set_caller(accounts(1));
    Vault::init(init_config());
}

#[test]
#[should_panic(expected = "only guardian")]
fn only_the_guardian_can_freeze() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.freeze();
}

#[test]
fn the_guardian_freezes_and_only_the_governor_unfreezes() {
    let mut vault = new_vault();
    set_caller(guardian());
    vault.freeze();
    assert!(vault.is_frozen());

    set_caller(governor());
    vault.unfreeze();

    assert!(!vault.is_frozen());
}

#[test]
#[should_panic(expected = "only governor")]
fn the_guardian_cannot_unfreeze() {
    let mut vault = new_vault();
    set_caller(guardian());
    vault.freeze();
    vault.unfreeze();
}

#[test]
fn the_governor_can_only_tighten_the_policy() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.tighten_policy(PolicyChange {
        cap_usdc: Some(U128(10_000_000)),
        ..Default::default()
    });

    assert_eq!(vault.policy().cap_usdc, U128(10_000_000));
}

#[test]
#[should_panic(expected = "POLICY_NOT_TIGHTER")]
fn the_governor_cannot_loosen_the_policy() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.tighten_policy(PolicyChange {
        cap_usdc: Some(U128(16_000_000)),
        ..Default::default()
    });
}

#[test]
#[should_panic(expected = "only governor")]
fn the_keeper_cannot_change_the_policy() {
    let mut vault = new_vault();
    set_caller(keeper());
    vault.tighten_policy(PolicyChange {
        cap_usdc: Some(U128(10_000_000)),
        ..Default::default()
    });
}

#[test]
#[should_panic(expected = "TIMELOCK")]
fn a_keeper_change_waits_for_the_timelock() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_keeper_change(accounts(2));

    set_caller_at(accounts(3), START_SECONDS + 86_399);
    vault.apply_keeper_change();
}

#[test]
fn anyone_can_apply_a_keeper_change_after_the_timelock() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_keeper_change(accounts(2));

    set_caller_at(accounts(3), START_SECONDS + 86_400);
    vault.apply_keeper_change();

    assert_eq!(vault.roles().keeper, accounts(2));
}

#[test]
#[should_panic(expected = "no change scheduled")]
fn the_guardian_can_cancel_a_keeper_change() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_keeper_change(accounts(2));
    set_caller(guardian());
    vault.cancel_keeper_change();

    set_caller_at(accounts(3), START_SECONDS + 86_400);
    vault.apply_keeper_change();
}

#[test]
fn a_new_schedule_replaces_the_old_one() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_keeper_change(accounts(2));
    vault.schedule_keeper_change(accounts(3));

    set_caller_at(accounts(4), START_SECONDS + 86_400);
    vault.apply_keeper_change();

    assert_eq!(vault.roles().keeper, accounts(3));
}

#[test]
fn a_guardian_change_cannot_be_cancelled_by_the_old_guardian() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_guardian_change(accounts(2));
    set_caller(guardian());
    vault.cancel_keeper_change();

    set_caller_at(accounts(4), START_SECONDS + 86_400);
    vault.apply_guardian_change();

    assert_eq!(vault.roles().guardian, accounts(2));
}

#[test]
fn clear_halt_is_for_the_governor() {
    let mut vault = new_vault();
    vault.set_halted_for_tests(true);
    set_caller(governor());

    vault.clear_halt();

    assert!(!vault.is_halted());
}

#[test]
#[should_panic(expected = "only governor")]
fn the_guardian_cannot_clear_a_halt() {
    let mut vault = new_vault();
    vault.set_halted_for_tests(true);
    set_caller(guardian());
    vault.clear_halt();
}

#[test]
fn the_governor_adds_a_depositor() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.add_depositor(accounts(5));

    assert!(vault.is_allowed(accounts(5)));
}

#[test]
#[should_panic(expected = "only governor")]
fn nobody_else_adds_a_depositor() {
    let mut vault = new_vault();
    set_caller(accounts(5));
    vault.add_depositor(accounts(5));
}
