use near_sdk::json_types::U128;
use near_sdk::test_utils::accounts;
use near_sdk::NearToken;

use crate::policy::PolicyChange;
use crate::tests::support::*;
use crate::{InitConfig, Vault};

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
#[should_panic(expected = "NEAR_RESERVE")]
fn adding_a_depositor_respects_the_near_reserve() {
    let mut vault = new_vault();
    set_caller_with_balance(governor(), NearToken::from_millinear(100));
    vault.add_depositor(accounts(5));
}

#[test]
fn a_scheduled_change_names_the_new_account() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.schedule_keeper_change(accounts(2));

    assert!(logs_contain(accounts(2).as_str()));
    assert!(logs_contain("apply_after"));
}

#[test]
fn a_tightened_policy_logs_what_changed() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.tighten_policy(PolicyChange {
        cap_usdc: Some(U128(10_000_000)),
        ..Default::default()
    });

    assert!(logs_contain("10000000"));
}

fn init_with(change: impl FnOnce(&mut InitConfig)) {
    let mut config = init_config();
    change(&mut config);
    set_caller(parent());
    Vault::init(config);
}

#[test]
#[should_panic(expected = "init: keeper must differ from the vault")]
fn the_keeper_cannot_be_the_vault() {
    init_with(|config| config.roles.keeper = vault_id());
}

#[test]
#[should_panic(expected = "init: governor must differ from the parent")]
fn the_governor_cannot_be_the_parent() {
    init_with(|config| config.roles.governor = parent());
}

#[test]
#[should_panic(expected = "init: keeper must differ from the guardian")]
fn the_keeper_cannot_be_the_guardian() {
    init_with(|config| config.roles.guardian = keeper());
}

#[test]
#[should_panic(expected = "init: timelock must be set")]
fn the_timelock_cannot_be_zero() {
    init_with(|config| config.policy.timelock = 0);
}

#[test]
#[should_panic(expected = "init: cooldown must be set")]
fn the_cooldown_cannot_be_zero() {
    init_with(|config| config.policy.cooldown = 0);
}

#[test]
#[should_panic(expected = "init: max_mint_per_cycle must be set")]
fn minting_cannot_be_switched_off() {
    init_with(|config| config.policy.max_mint_per_cycle = 0);
}

#[test]
#[should_panic(expected = "init: epoch_len must hold two cooldowns")]
fn a_zero_window_is_refused() {
    init_with(|config| config.policy.epoch_len = 0);
}

#[test]
#[should_panic(expected = "init: epoch_len must hold two cooldowns")]
fn a_window_under_two_cooldowns_is_refused() {
    init_with(|config| config.policy.epoch_len = 2 * config.policy.cooldown - 1);
}

#[test]
#[should_panic(expected = "init: decision_ttl must be set")]
fn a_decision_must_live_for_some_time() {
    init_with(|config| config.policy.decision_ttl = 0);
}

#[test]
#[should_panic(expected = "init: abort_after_blocks must be set")]
fn the_abort_timer_cannot_be_zero() {
    init_with(|config| config.policy.abort_after_blocks = 0);
}

#[test]
#[should_panic(expected = "init: max_execution_seconds must be set")]
fn a_run_must_have_some_time() {
    init_with(|config| config.policy.max_execution_seconds = 0);
}

#[test]
#[should_panic(expected = "init: commitment must be 64 lowercase hex")]
fn a_commitment_in_the_wrong_form_is_refused() {
    init_with(|config| config.agent.commitment = "0xABC".to_string());
}

#[test]
#[should_panic(expected = "init: commitment must be 64 lowercase hex")]
fn an_uppercase_commitment_is_refused() {
    init_with(|config| config.agent.commitment = "AA".repeat(32));
}

#[test]
#[should_panic(expected = "init: reveal_after is more than a year away")]
fn a_reveal_time_in_milliseconds_is_refused() {
    init_with(|config| config.agent.reveal_after = START_SECONDS * 1_000);
}

#[test]
#[should_panic(expected = "keeper must differ from the vault")]
fn a_keeper_rotation_cannot_pick_the_vault() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.schedule_keeper_change(vault_id());
}

#[test]
#[should_panic(expected = "keeper must differ from the guardian")]
fn a_keeper_rotation_cannot_pick_the_guardian() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.schedule_keeper_change(guardian());
}

#[test]
#[should_panic(expected = "keeper must differ from the guardian")]
fn a_guardian_rotation_cannot_pick_the_keeper() {
    let mut vault = new_vault();
    set_caller(governor());

    vault.schedule_guardian_change(keeper());
}

#[test]
#[should_panic(expected = "keeper must differ from the guardian")]
fn two_rotations_cannot_meet_on_one_account() {
    let mut vault = new_vault();
    set_caller(governor());
    vault.schedule_keeper_change(alice());
    vault.schedule_guardian_change(alice());
    let later = START_SECONDS + vault.policy().timelock;
    set_caller_at(bob(), later);
    vault.apply_keeper_change();

    vault.apply_guardian_change();
}

#[test]
#[should_panic(expected = "init: max_instructions must be set")]
fn a_run_must_have_some_instructions() {
    init_with(|config| config.agent.max_instructions = 0);
}

#[test]
#[should_panic(expected = "init: max_memory_mb must be set")]
fn a_run_must_have_some_memory() {
    init_with(|config| config.agent.max_memory_mb = 0);
}

#[test]
#[should_panic(expected = "init: build_target must be set")]
fn a_run_must_name_its_build_target() {
    init_with(|config| config.agent.build_target = String::new());
}

#[test]
fn the_sealed_config_can_be_read() {
    let vault = new_vault();

    assert_eq!(vault.agent(), init_config().agent);
    assert_eq!(vault.assets(), init_config().assets);
    assert_eq!(vault.oracle(), init_config().oracle);
}

#[test]
fn a_pending_rotation_can_be_read() {
    let mut vault = new_vault();
    assert_eq!(vault.keeper_change(), None);
    assert_eq!(vault.guardian_change(), None);
    set_caller(governor());

    vault.schedule_keeper_change(alice());
    vault.schedule_guardian_change(bob());

    assert_eq!(vault.keeper_change().unwrap().account, alice());
    assert_eq!(vault.guardian_change().unwrap().account, bob());
}

#[test]
#[should_panic(expected = "init: stuck_after must be set")]
fn the_stuck_timer_cannot_be_zero() {
    init_with(|config| config.policy.stuck_after = 0);
}

#[test]
#[should_panic(expected = "init: halt_after must pass stuck_after")]
fn the_halt_timer_must_pass_the_stuck_timer() {
    init_with(|config| config.policy.halt_after = config.policy.stuck_after);
}

#[test]
#[should_panic(expected = "init: reveal_after must be in the future")]
fn the_reveal_time_cannot_have_passed() {
    init_with(|config| config.agent.reveal_after = START_SECONDS);
}

#[test]
#[should_panic(expected = "init: abort_after_blocks must pass the yield timeout")]
fn an_abort_cannot_beat_the_yield_timeout() {
    init_with(|config| config.policy.abort_after_blocks = 200);
}

#[test]
#[should_panic(expected = "init: a bps limit above 100%")]
fn a_cap_cannot_pass_the_whole_book() {
    init_with(|config| config.policy.cap_bps = 10_001);
}

#[test]
#[should_panic(expected = "init: a bps limit above 100%")]
fn an_epoch_cap_cannot_pass_the_whole_book() {
    init_with(|config| config.policy.epoch_cap_bps = 10_001);
}

#[test]
#[should_panic(expected = "init: a bps limit above 100%")]
fn a_sell_cap_cannot_pass_the_whole_book() {
    init_with(|config| config.policy.cap_sell_bps = 10_001);
}

#[test]
#[should_panic(expected = "init: a bps limit above 100%")]
fn the_risk_limit_cannot_pass_the_whole_book() {
    init_with(|config| config.policy.max_risk_bps = 10_001);
}

#[test]
#[should_panic(expected = "init: a duration above one year")]
fn a_duration_that_would_overflow_is_refused() {
    init_with(|config| config.policy.decision_ttl = u64::MAX);
}

#[test]
#[should_panic(expected = "init: a duration above one year")]
fn a_timelock_of_centuries_is_refused() {
    init_with(|config| config.policy.timelock = u64::MAX);
}

#[test]
#[should_panic(expected = "init: near_reserve must be set")]
fn the_near_reserve_cannot_be_zero() {
    init_with(|config| config.policy.near_reserve = U128(0));
}

#[test]
#[should_panic(expected = "init: min_deposit must be set")]
fn the_minimum_deposit_cannot_be_zero() {
    init_with(|config| config.policy.min_deposit = U128(0));
}

#[test]
#[should_panic(expected = "init: the token decimals are too far apart")]
fn a_decimal_gap_that_overflows_the_scale_is_refused() {
    init_with(|config| {
        config.assets.usdc_decimals = 0;
        config.assets.wnear_decimals = 39;
    });
}

#[test]
#[should_panic(expected = "init: the two tokens must differ")]
fn the_two_tokens_cannot_be_the_same() {
    init_with(|config| config.assets.usdc = config.assets.wnear.clone());
}

#[test]
#[should_panic(expected = "init: usdc_decimals above wnear_decimals")]
fn usdc_cannot_have_more_decimals_than_wnear() {
    init_with(|config| config.assets.usdc_decimals = 25);
}

#[test]
#[should_panic(expected = "init: slippage_bps must stay below 100%")]
fn the_slippage_cannot_reach_the_whole_trade() {
    init_with(|config| config.policy.slippage_bps = 10_000);
}

#[test]
#[should_panic(expected = "init: outlayer_deposit above ops_budget")]
fn one_run_must_fit_the_ops_budget() {
    init_with(|config| config.agent.outlayer_deposit = U128(config.policy.ops_budget.0 + 1));
}

#[test]
#[should_panic(expected = "init: the two price feeds must differ")]
fn the_price_feeds_cannot_be_the_same() {
    init_with(|config| config.oracle.usdc_id = config.oracle.near_id.clone());
}

#[test]
#[should_panic(expected = "init: wasm_hash must be set")]
fn the_wasm_hash_cannot_be_empty() {
    init_with(|config| config.agent.wasm_hash = String::new());
}

#[test]
#[should_panic(expected = "init: commitment must be 64 lowercase hex")]
fn the_commitment_cannot_be_empty() {
    init_with(|config| config.agent.commitment = String::new());
}

#[test]
#[should_panic(expected = "init: per_user_cap above tvl_cap")]
fn the_user_cap_cannot_pass_the_tvl_cap() {
    init_with(|config| config.policy.per_user_cap = U128(config.policy.tvl_cap.0 + 1));
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
