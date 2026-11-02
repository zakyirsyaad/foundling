use near_sdk::env;
use near_sdk::serde_json::{self, Value};

use crate::tests::support::*;
use crate::{InitConfig, Vault};

const OPENS_AT: u64 = START_SECONDS + 3_600;
// The strategy test `the_shared_fixture_matches_this_crate` pins the same file.
const FIXTURE: &str = include_str!("../../../../strategy/fixtures/commitment.json");

fn text(field: &str) -> String {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    fixture[field].as_str().unwrap().to_string()
}

fn vault_with(change: impl FnOnce(&mut InitConfig)) -> Vault {
    let mut config = init_config();
    config.agent.commitment = text("commitment");
    config.agent.chain = text("chain");
    config.agent.wasm_hash = text("wasm_hash");
    change(&mut config);
    set_caller(parent());
    Vault::init(config)
}

fn committed_vault() -> Vault {
    vault_with(|_| {})
}

fn reveal_at_open(vault: &mut Vault) {
    set_caller_at(alice(), OPENS_AT);
    vault.reveal(text("params"), text("salt"));
}

#[test]
fn the_fixture_is_for_this_vault() {
    assert_eq!(text("vault"), vault_id().as_str());
}

#[test]
fn the_view_gives_the_opening_time() {
    assert_eq!(committed_vault().reveal_after(), OPENS_AT);
}

#[test]
fn the_strategy_commitment_opens_here() {
    let mut vault = committed_vault();

    reveal_at_open(&mut vault);

    assert_eq!(vault.revealed(), Some(text("params")));
}

#[test]
fn nothing_is_revealed_at_the_start() {
    assert_eq!(committed_vault().revealed(), None);
}

#[test]
#[should_panic(expected = "TOO_EARLY")]
fn a_reveal_before_the_time_is_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT - 1);

    vault.reveal(text("params"), text("salt"));
}

#[test]
fn anyone_can_reveal() {
    let mut vault = committed_vault();
    set_caller_at(bob(), OPENS_AT);

    vault.reveal(text("params"), text("salt"));

    assert!(vault.revealed().is_some());
}

#[test]
fn the_event_publishes_the_salt_and_the_view_the_params() {
    let mut vault = committed_vault();

    reveal_at_open(&mut vault);

    assert!(logs_contain("revealed"));
    assert!(logs_contain(&text("salt")));
    assert_eq!(vault.revealed(), Some(text("params")));
}

#[test]
fn the_salt_stays_readable_after_the_logs_are_gone() {
    let mut vault = committed_vault();
    assert_eq!(vault.revealed_salt(), None);

    reveal_at_open(&mut vault);

    assert_eq!(vault.revealed_salt(), Some(text("salt")));
}

fn commitment_of_params(params: &str) -> String {
    let salt: Vec<u8> = (0..32).collect();
    let fields = [
        text("chain").into_bytes(),
        text("vault").into_bytes(),
        text("wasm_hash").into_bytes(),
        params.as_bytes().to_vec(),
        salt,
    ];
    let mut preimage = b"foundling/v1/commitment".to_vec();
    for field in fields {
        preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
        preimage.extend_from_slice(&field);
    }
    env::sha256(&preimage)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn a_long_parameter_text_still_opens() {
    set_caller(parent());
    let params = "x".repeat(20_000);
    let commitment = commitment_of_params(&params);
    let mut vault = vault_with(|config| config.agent.commitment = commitment);
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(params.clone(), text("salt"));

    assert_eq!(vault.revealed(), Some(params));
}

#[test]
#[should_panic(expected = "BAD_REVEAL")]
fn other_params_are_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params").replace("1000", "1001"), text("salt"));
}

#[test]
#[should_panic(expected = "BAD_REVEAL")]
fn the_same_params_in_another_order_are_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);
    let reordered = text("params").replace(
        r#""buy_usdc":"1000","risk_off_below""#,
        r#""risk_off_below""#,
    );

    vault.reveal(reordered, text("salt"));
}

#[test]
#[should_panic(expected = "BAD_REVEAL")]
fn another_salt_is_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), "ff".repeat(32));
}

#[test]
#[should_panic(expected = "BAD_SALT")]
fn a_short_salt_is_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), "00".repeat(31));
}

#[test]
#[should_panic(expected = "BAD_SALT")]
fn a_salt_that_is_not_hex_is_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), "zz".repeat(32));
}

#[test]
#[should_panic(expected = "BAD_SALT")]
fn a_salt_with_sign_characters_is_refused() {
    let mut vault = committed_vault();
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), "+0".repeat(32));
}

#[test]
#[should_panic(expected = "BAD_REVEAL")]
fn a_commitment_for_another_chain_does_not_open() {
    let mut vault = vault_with(|config| config.agent.chain = "mainnet".to_string());
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), text("salt"));
}

#[test]
#[should_panic(expected = "BAD_REVEAL")]
fn a_commitment_for_another_binary_does_not_open() {
    let mut vault = vault_with(|config| config.agent.wasm_hash = "cc".to_string());
    set_caller_at(alice(), OPENS_AT);

    vault.reveal(text("params"), text("salt"));
}

#[test]
#[should_panic(expected = "ALREADY_REVEALED")]
fn a_second_reveal_is_refused() {
    let mut vault = committed_vault();
    reveal_at_open(&mut vault);

    vault.reveal(text("params"), text("salt"));
}

#[test]
fn a_frozen_vault_can_reveal() {
    let mut vault = committed_vault();
    set_caller(guardian());
    vault.freeze();

    reveal_at_open(&mut vault);

    assert!(vault.revealed().is_some());
}

#[test]
fn a_halted_vault_can_reveal() {
    let mut vault = committed_vault();
    vault.set_halted_for_tests(true);

    reveal_at_open(&mut vault);

    assert!(vault.revealed().is_some());
}

#[test]
fn a_reveal_works_in_the_middle_of_a_cycle() {
    let mut vault = committed_vault();
    set_caller(keeper());
    vault.trigger_cycle();

    reveal_at_open(&mut vault);

    assert!(vault.revealed().is_some());
}
