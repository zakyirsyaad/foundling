//! A real testnet cycle, then the same cycle with one thing wrong each time. The fixture comes
//! from `tools/fetch_proof.py` on a burner vault, and every value in it is public on chain.
//!
//! Its binary predates `prompt` in `Params`, so this commit cannot open it. The real cycle
//! runs with the parameters withheld. The opening runs on the same numbers sealed again under
//! today's rule, through the whole `check`: no quote covers those decision bytes, so every
//! such report also fails "output hash", and only that. A run of a binary with `prompt`
//! replaces this split with one fixture that passes everything.

use base64::{engine::general_purpose::STANDARD, Engine};
use foundling_strategy::{
    commitment, decide, inputs_digest, Action, Decision, Input, Params, Regime,
};
use foundling_verify::check;
use foundling_verify::hex::decode;
use foundling_verify::proof::Proof;
use foundling_verify::report::Report;

const FIXTURE: &str = include_str!("../fixtures/testnet-proof.json");
const QUOTE_REPORT_DATA_OFFSET: usize = 48 + 520;
const TEN_YEARS_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;
const PROMPT: &str = "Classify the headlines.";
/// What `check` says about decision bytes no quote covers.
const UNCOVERED: &str = "output hash";

fn fixture() -> Proof {
    serde_json::from_str(FIXTURE).unwrap()
}

/// The real cycle before any reveal: everything a quote covers, and no parameters to open.
fn proof() -> Proof {
    Proof {
        opening: None,
        ..fixture()
    }
}

/// The fixture's numbers with a prompt, sealed under today's rule. Its decision bytes differ
/// from the attested ones, so `check` also fails "output hash" on it.
fn opened() -> Proof {
    let mut proof = fixture();
    let opening = proof.opening.as_mut().unwrap();
    let mut fields: serde_json::Value = serde_json::from_str(&opening.params).unwrap();
    fields["prompt"] = PROMPT.into();
    let params: Params = serde_json::from_value(fields).unwrap();
    opening.params = params.canonical();
    let salt = decode(&opening.salt).unwrap();
    let sealed = commitment(&proof.chain, &proof.vault, &proof.wasm_hash, &params, &salt);
    for cycle in &mut proof.cycles {
        cycle.decision = replaced(&cycle.decision, &proof.commitment, &sealed);
    }
    proof.commitment = sealed;
    proof
}

/// `opened()` with the AI Risk Manager's thresholds sealed in on top of the fixture's own
/// params, and the first cycle's `obs`/decision rewritten to whatever `decide` gives for the
/// chosen score on this input — proving the replay path (not the rule itself, which
/// `strategy::tests` already covers) carries `ai_risk` end to end: through `Obs`'s JSON
/// shape, the resealed commitment, and `inputs_digest`. A `wnear_book` other than the
/// fixture's own (zero, so a protective sell always rounds to nothing) changes `input_data`,
/// so a proof built with one also fails the attestation's "input hash" — the same way
/// `changed_input_bytes_are_caught_by_the_digest_and_the_quote` catches it.
///
/// Limit: the decision is built here by the same production `decide`, so no TEE quote covers
/// it. These cases prove the replay plumbing only, never that an AI-managed decision carries a
/// valid attestation end to end; that needs a captured AI Risk Manager proof.
fn risk_managed(
    ai_risk: u8,
    ai_conf: u8,
    veto_at: u8,
    exit_at: u8,
    exit_conf: u8,
    wnear_book: Option<&str>,
) -> Proof {
    let mut proof = opened();
    let opening = proof.opening.as_mut().unwrap();
    let mut fields: serde_json::Value = serde_json::from_str(&opening.params).unwrap();
    fields["ai_veto_at"] = veto_at.to_string().into();
    fields["ai_exit_at"] = exit_at.to_string().into();
    fields["ai_exit_conf"] = exit_conf.to_string().into();
    let params: Params = serde_json::from_value(fields).unwrap();
    opening.params = params.canonical();
    let salt = decode(&opening.salt).unwrap();
    let sealed = commitment(&proof.chain, &proof.vault, &proof.wasm_hash, &params, &salt);

    let cycle = &mut proof.cycles[0];
    if let Some(book) = wnear_book {
        cycle.input_data = replaced(
            &cycle.input_data,
            r#""wnear_book":"0""#,
            &format!(r#""wnear_book":"{book}""#),
        );
    }
    let input: Input = serde_json::from_str(&cycle.input_data).unwrap();
    let mut decision: Decision = serde_json::from_str(&cycle.decision).unwrap();
    decision.obs.ai_conf = ai_conf;
    decision.obs.ai_risk = Some(ai_risk);
    let verdict = decide(&params, &input, &decision.obs);
    decision.regime = verdict.regime;
    decision.action = verdict.action;
    decision.amount_in = verdict.amount_in;
    decision.ref_price = verdict.ref_price;
    decision.inputs_digest = inputs_digest(
        &cycle.input_data,
        &decision.obs,
        &decision.ai_ref.resp_sig_hash,
    );
    decision.commitment = sealed.clone();
    cycle.decision = serde_json::to_string(&decision).unwrap();

    proof.commitment = sealed;
    proof
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
    assert_report_fails(&check(proof), expected);
}

/// For a proof built on `opened`: the expected failures plus the uncovered output bytes.
fn assert_opened_fails(proof: &Proof, expected: &[&str]) {
    let mut all = vec![UNCOVERED];
    all.extend_from_slice(expected);
    assert_fails(proof, &all);
}

fn assert_report_fails(report: &Report, expected: &[&str]) {
    let lines = failed(report);
    for needle in expected {
        assert!(
            lines.iter().any(|line| line.contains(needle)),
            "{needle} did not fail in {lines:?}"
        );
    }
    assert_eq!(lines.len(), expected.len(), "{lines:?}");
}

#[test]
fn before_reveal_a_real_cycle_passes_and_the_replay_is_skipped() {
    let report = check(&proof());
    assert_eq!(failed(&report), Vec::<&str>::new());
    assert_eq!(report.skipped, 2);
    assert!(!report.lines.iter().any(|line| line.contains("reproduced")));
    assert_eq!(report.summary(), "SUMMARY pass=12 skip=2 fail=0");
}

#[test]
fn an_opening_sealed_under_this_rule_reproduces_the_decision() {
    let report = check(&opened());
    assert_report_fails(&report, &[UNCOVERED]);
    assert_eq!(report.skipped, 0);
    assert!(report
        .lines
        .iter()
        .any(|line| line == "PASS nonce 1 replay"));
    assert!(report.lines.iter().any(|line| line == "1/1 reproduced"));
    assert_eq!(report.summary(), "SUMMARY pass=13 skip=0 fail=1");
}

#[test]
fn a_build_from_before_the_prompt_cannot_be_opened_by_this_one() {
    let report = check(&fixture());
    assert_report_fails(&report, &["not canonical"]);
    assert_eq!(report.skipped, 1);
}

#[test]
fn a_proof_without_cycles_fails() {
    let mut proof = proof();
    proof.cycles.clear();
    assert_fails(&proof, &["proof has cycles"]);
}

#[test]
fn another_salt_fails_the_commitment() {
    let mut proof = opened();
    proof.opening.as_mut().unwrap().salt = "11".repeat(32);
    let report = check(&proof);
    assert_report_fails(&report, &[UNCOVERED, "another commitment"]);
    assert_eq!(report.skipped, 1);
}

#[test]
fn a_short_salt_fails_the_commitment() {
    let mut proof = opened();
    proof.opening.as_mut().unwrap().salt = "11".to_string();
    assert_opened_fails(&proof, &["32 bytes"]);
}

#[test]
fn parameters_that_are_not_canonical_fail() {
    let mut proof = opened();
    let opening = proof.opening.as_mut().unwrap();
    opening.params = format!(" {}", opening.params);
    assert_opened_fails(&proof, &["not canonical"]);
}

#[test]
fn another_commitment_on_chain_fails_the_binding_too() {
    let mut proof = opened();
    proof.commitment = "00".repeat(32);
    assert_opened_fails(&proof, &["another commitment", "binding"]);
}

#[test]
fn a_changed_amount_is_caught_by_the_replay_and_the_quote() {
    let change = |proof: &mut Proof| {
        let cycle = &mut proof.cycles[0];
        cycle.decision = replaced(
            &cycle.decision,
            r#""amount_in":"50000""#,
            r#""amount_in":"40000""#,
        );
    };
    let (mut attested, mut sealed) = (proof(), opened());
    change(&mut attested);
    change(&mut sealed);
    assert_fails(&attested, &["output hash"]);
    assert_opened_fails(&sealed, &["replay"]);
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
    let mut proof = opened();
    proof.vault = "other.testnet".to_string();
    assert_opened_fails(&proof, &["another commitment", "binding"]);
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

#[test]
fn a_severe_risk_replays_a_protective_sell() {
    // risk 90 >= exit_at 80, conf 90 >= exit_conf 70: severe, regardless of veto_at. This
    // runs in the fixture's own regime, risk_on; that the same sell fires in risk_off and
    // undetermined too (SPEC §3.2 rule 1, "pada rezim apa pun") is `strategy`'s to prove
    // (`a_severe_confident_risk_sells_while_the_price_says_buy`) — this test is about the
    // replay path, not the rule's regime-independence.
    let proof = risk_managed(90, 90, 50, 80, 70, Some("1000"));
    let decision: Decision = serde_json::from_str(&proof.cycles[0].decision).unwrap();
    assert_eq!(decision.regime, Regime::RiskOn);
    assert_eq!(decision.action, Action::SellRisk);
    assert_eq!(decision.amount_in, 1000); // the whole dry book; `sell_wnear` never binds here

    let report = check(&proof);
    assert_report_fails(&report, &[UNCOVERED, "input hash"]);
    assert_eq!(report.skipped, 0);
    assert!(report
        .lines
        .iter()
        .any(|line| line == "PASS nonce 1 replay"));
    assert!(report.lines.iter().any(|line| line == "1/1 reproduced"));
}

#[test]
fn a_risk_under_the_veto_replays_a_scaled_buy() {
    // risk 30 < veto_at 50: not severe (30 < exit_at 80 too), so the price rule's buy_risk
    // scales down to buy_usdc * (100 - 30) / 100 = 50000 * 70 / 100 = 35000.
    let proof = risk_managed(30, 0, 50, 80, 70, None);
    let decision: Decision = serde_json::from_str(&proof.cycles[0].decision).unwrap();
    assert_eq!(decision.regime, Regime::RiskOn);
    assert_eq!(decision.action, Action::BuyRisk);
    assert_eq!(decision.amount_in, 35_000);

    let report = check(&proof);
    assert_report_fails(&report, &[UNCOVERED]);
    assert_eq!(report.skipped, 0);
    assert!(report
        .lines
        .iter()
        .any(|line| line == "PASS nonce 1 replay"));
    assert!(report.lines.iter().any(|line| line == "1/1 reproduced"));
}

#[test]
fn a_risk_at_the_veto_replays_a_held_buy() {
    // risk 60 >= veto_at 50 vetoes the buy, and 60 < exit_at 80 keeps the sell from firing:
    // the AI only lowers exposure, so this is a hold, not the scaled or price-rule trade.
    let proof = risk_managed(60, 0, 50, 80, 70, None);
    let decision: Decision = serde_json::from_str(&proof.cycles[0].decision).unwrap();
    assert_eq!(decision.regime, Regime::RiskOn);
    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.amount_in, 0);

    let report = check(&proof);
    assert_report_fails(&report, &[UNCOVERED]);
    assert_eq!(report.skipped, 0);
    assert!(report
        .lines
        .iter()
        .any(|line| line == "PASS nonce 1 replay"));
    assert!(report.lines.iter().any(|line| line == "1/1 reproduced"));
}

#[test]
fn a_decision_without_ai_risk_still_replays_under_the_earlier_rule() {
    // `opened()` alone (no AI Risk Manager thresholds) is exactly a vault born before it:
    // `before_reveal_a_real_cycle_passes_and_the_replay_is_skipped` and
    // `an_opening_sealed_under_this_rule_reproduces_the_decision` already cover this through
    // the whole replay path, including `inputs_digest` with no `ai_risk` in `obs`. This test
    // only pins the fact down against `foundling_strategy` directly, so a change to
    // `Obs::canonical`'s omission of an absent `ai_risk` fails here before it fails there.
    let proof = opened();
    let decision: Decision = serde_json::from_str(&proof.cycles[0].decision).unwrap();
    assert_eq!(decision.obs.ai_risk, None);
    assert_eq!(
        decision.obs.canonical(),
        r#"{"ai_conf":0,"ai_flag":0,"pa":"210000000","pb":"210000000","ta":1793556265,"tb":1793556265}"#
    );
}
