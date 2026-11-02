//! A real testnet cycle, then the same cycle with one thing wrong each time. The fixture comes
//! from `tools/fetch_proof.py` on a burner vault, and every value in it is public on chain.

use base64::{engine::general_purpose::STANDARD, Engine};
use foundling_verify::check;
use foundling_verify::proof::Proof;
use foundling_verify::report::Report;

const FIXTURE: &str = include_str!("../fixtures/testnet-proof.json");
const QUOTE_REPORT_DATA_OFFSET: usize = 48 + 520;
const TEN_YEARS_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;

fn proof() -> Proof {
    serde_json::from_str(FIXTURE).unwrap()
}

fn replaced(text: &str, old: &str, new: &str) -> String {
    assert!(text.contains(old), "{old} is not in {text}");
    text.replace(old, new)
}

fn failed(report: &Report) -> Vec<&str> {
    report
        .lines
        .iter()
        .filter(|line| line.starts_with("FAIL"))
        .map(String::as_str)
        .collect()
}

fn assert_fails(proof: &Proof, expected: &[&str]) {
    let report = check(proof);
    let lines = failed(&report);
    for needle in expected {
        assert!(
            lines.iter().any(|line| line.contains(needle)),
            "{needle} did not fail in {lines:?}"
        );
    }
    assert_eq!(lines.len(), expected.len(), "{lines:?}");
}

#[test]
fn a_real_cycle_passes_every_check() {
    let report = check(&proof());
    assert_eq!(failed(&report), Vec::<&str>::new());
    assert_eq!(report.skipped, 0);
    assert!(report.lines.iter().any(|line| line == "1/1 reproduced"));
    assert_eq!(report.summary(), "SUMMARY pass=14 skip=0 fail=0");
}

#[test]
fn before_reveal_the_replay_is_skipped_and_nothing_fails() {
    let mut proof = proof();
    proof.opening = None;
    let report = check(&proof);
    assert_eq!(failed(&report), Vec::<&str>::new());
    assert_eq!(report.skipped, 2);
    assert!(!report.lines.iter().any(|line| line.contains("reproduced")));
}

#[test]
fn a_proof_without_cycles_fails() {
    let mut proof = proof();
    proof.cycles.clear();
    assert_fails(&proof, &["proof has cycles"]);
}

#[test]
fn another_salt_fails_the_commitment() {
    let mut proof = proof();
    proof.opening.as_mut().unwrap().salt = "11".repeat(32);
    let report = check(&proof);
    assert_eq!(failed(&report).len(), 1);
    assert!(failed(&report)[0].contains("another commitment"));
    assert_eq!(report.skipped, 1);
}

#[test]
fn a_short_salt_fails_the_commitment() {
    let mut proof = proof();
    proof.opening.as_mut().unwrap().salt = "11".to_string();
    assert_fails(&proof, &["32 bytes"]);
}

#[test]
fn parameters_that_are_not_canonical_fail() {
    let mut proof = proof();
    let opening = proof.opening.as_mut().unwrap();
    opening.params = format!(" {}", opening.params);
    assert_fails(&proof, &["not canonical"]);
}

#[test]
fn another_commitment_on_chain_fails_the_binding_too() {
    let mut proof = proof();
    proof.commitment = "00".repeat(32);
    assert_fails(&proof, &["another commitment", "binding"]);
}

#[test]
fn a_changed_amount_is_caught_by_the_replay_and_the_quote() {
    let mut proof = proof();
    let cycle = &mut proof.cycles[0];
    cycle.decision = replaced(
        &cycle.decision,
        r#""amount_in":"50000""#,
        r#""amount_in":"40000""#,
    );
    assert_fails(&proof, &["replay", "output hash"]);
}

#[test]
fn changed_input_bytes_are_caught_by_the_digest_and_the_quote() {
    let mut proof = proof();
    let cycle = &mut proof.cycles[0];
    cycle.input_data = format!(" {}", cycle.input_data);
    assert_fails(&proof, &["inputs_digest", "input hash"]);
}

#[test]
fn a_changed_price_is_caught_by_the_digest_and_the_quote() {
    let mut proof = proof();
    let cycle = &mut proof.cycles[0];
    cycle.decision = replaced(
        &cycle.decision,
        r#""pa":"210000000""#,
        r#""pa":"210000001""#,
    );
    assert_fails(&proof, &["inputs_digest", "output hash"]);
}

#[test]
fn a_proof_for_another_vault_fails_the_binding() {
    let mut proof = proof();
    proof.vault = "other.testnet".to_string();
    assert_fails(&proof, &["another commitment", "binding"]);
}

#[test]
fn an_attestation_for_another_tx_fails() {
    let mut proof = proof();
    proof.cycles[0].tx = "another".to_string();
    assert_fails(&proof, &["attestation names this tx"]);
}

#[test]
fn another_wasm_hash_fails_the_task_hash() {
    let mut proof = proof();
    proof.cycles[0].attestation.wasm_hash = "00".repeat(32);
    assert_fails(&proof, &["wasm hash", "Task Hash"]);
}

#[test]
fn a_wrong_executed_hash_is_flagged_though_the_quote_does_not_cover_it() {
    let mut proof = proof();
    proof.cycles[0].attestation.executed_wasm_sha256 = "00".repeat(32);
    assert_fails(&proof, &["wasm hash"]);
}

#[test]
fn another_secret_row_fails() {
    let mut proof = proof();
    proof.secrets_ref = "someone.testnet/other".to_string();
    assert_fails(&proof, &["secrets"]);
}

#[test]
fn every_field_of_the_task_hash_is_bound() {
    let original = proof();

    let mut changed = original.clone();
    changed.cycles[0].attestation.timestamp += 1;
    assert_fails(&changed, &["Task Hash"]);

    let mut changed = original.clone();
    changed.cycles[0].attestation.block_height += 1;
    assert_fails(&changed, &["Task Hash"]);

    let mut changed = original.clone();
    changed.cycles[0].attestation.task_id += 1;
    assert_fails(&changed, &["Task Hash"]);

    let mut changed = original.clone();
    changed.cycles[0].attestation.caller_account_id = "other.testnet".to_string();
    assert_fails(&changed, &["Task Hash"]);

    let mut changed = original.clone();
    changed.cycles[0].attestation.attached_usd = "1".to_string();
    assert_fails(&changed, &["Task Hash"]);
}

#[test]
fn a_flipped_bit_in_the_quote_fails_its_signature() {
    let mut proof = proof();
    let attestation = &mut proof.cycles[0].attestation;
    let mut quote = STANDARD.decode(&attestation.tdx_quote).unwrap();
    quote[QUOTE_REPORT_DATA_OFFSET] ^= 1;
    attestation.tdx_quote = STANDARD.encode(quote);
    assert_fails(&proof, &["quote"]);
}

#[test]
fn a_worker_off_the_approved_list_fails() {
    let mut proof = proof();
    proof.approved_measurements.clear();
    assert_fails(&proof, &["approved measurements"]);
}

#[test]
fn a_reply_naming_another_measurement_fails() {
    let mut proof = proof();
    proof.cycles[0].attestation.worker_measurement = "00".repeat(48);
    assert_fails(&proof, &["worker measurement"]);
}

#[test]
fn collateral_past_its_life_fails_the_quote() {
    let mut proof = proof();
    proof.cycles[0].collateral_fetched_at += TEN_YEARS_SECONDS;
    assert_fails(&proof, &["quote"]);
}
