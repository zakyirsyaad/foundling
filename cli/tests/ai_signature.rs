//! The NEAR AI signature a worker archived for a real testnet cycle, then the same archive with
//! one thing wrong each time. The fixture comes from `tools/fetch_proof.py` with
//! `NEARAI_ARCHIVE_KEY` set, on the burner vault `vault.fdl-adv2-7d4520.testnet` (PR #13 at
//! 60375e8), revealed. Every value in it is public; the key is not in it.

use base64::{engine::general_purpose::STANDARD, Engine};
use foundling_verify::check;
use foundling_verify::proof::{AiArchive, AiSignature, Proof};
use foundling_verify::report::Report;

const FIXTURE: &str = include_str!("../fixtures/testnet-advisor-proof.json");
const OTHER_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn proof() -> Proof {
    serde_json::from_str(FIXTURE).unwrap()
}

fn archived(proof: &mut Proof) -> &mut AiSignature {
    match proof.cycles[0].ai_signature.as_mut().unwrap() {
        AiArchive::Archived(signature) => signature,
        AiArchive::Missing { .. } => panic!("the fixture has an archive"),
    }
}

fn ai_lines(report: &Report) -> Vec<&str> {
    report
        .lines
        .iter()
        .map(String::as_str)
        .filter(|line| line.contains(" ai "))
        .collect()
}

fn failed(report: &Report) -> Vec<&str> {
    report
        .lines
        .iter()
        .filter_map(|line| line.strip_prefix("FAIL "))
        .map(|line| line.split(':').next().unwrap())
        .collect()
}

#[test]
fn the_real_archive_passes_every_check() {
    let report = check(&proof());

    assert_eq!(report.failed, 0, "{:#?}", report.lines);
    assert_eq!(report.skipped, 0, "{:#?}", report.lines);
    assert_eq!(
        ai_lines(&report),
        [
            "PASS nonce 1 ai model",
            "PASS nonce 1 ai reply",
            "PASS nonce 1 ai signer",
            "PASS nonce 1 ai report",
            "PASS nonce 1 ai quote",
            "PASS nonce 1 ai report data",
        ]
    );
}

#[test]
fn a_signature_over_another_reply_fails() {
    let mut proof = proof();
    let signature = archived(&mut proof);
    let (head, _) = signature.text.rsplit_once(':').unwrap();
    signature.text = format!("{head}:{OTHER_HASH}");

    let report = check(&proof);
    let failed_checks = failed(&report);

    assert!(
        failed_checks.contains(&"nonce 1 ai reply"),
        "{failed_checks:?}"
    );
    assert!(
        failed_checks.contains(&"nonce 1 ai signer"),
        "{failed_checks:?}"
    );
}

#[test]
fn a_signature_naming_another_model_fails() {
    let mut proof = proof();
    let signature = archived(&mut proof);
    signature.text = signature
        .text
        .replacen("z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B", 1);

    assert!(failed(&check(&proof)).contains(&"nonce 1 ai model"));
}

#[test]
fn a_forged_signature_fails() {
    let mut proof = proof();
    let signature = archived(&mut proof);
    let mut chars: Vec<char> = signature.signature.chars().collect();
    chars[10] = if chars[10] == 'a' { 'b' } else { 'a' };
    signature.signature = chars.into_iter().collect();

    assert_eq!(failed(&check(&proof)), ["nonce 1 ai signer"]);
}

#[test]
fn a_signer_the_report_does_not_name_fails() {
    let mut proof = proof();
    archived(&mut proof).signing_address = "0x0000000000000000000000000000000000000001".into();

    let report = check(&proof);
    let failed_checks = failed(&report);

    assert!(
        failed_checks.contains(&"nonce 1 ai signer"),
        "{failed_checks:?}"
    );
    assert!(
        failed_checks.contains(&"nonce 1 ai report"),
        "{failed_checks:?}"
    );
}

#[test]
fn a_report_not_made_for_this_reply_fails() {
    let mut proof = proof();
    archived(&mut proof).report.request_nonce = OTHER_HASH.into();

    let report = check(&proof);
    let failed_checks = failed(&report);

    assert!(
        failed_checks.contains(&"nonce 1 ai report"),
        "{failed_checks:?}"
    );
    assert!(
        failed_checks.contains(&"nonce 1 ai report data"),
        "{failed_checks:?}"
    );
}

#[test]
fn a_real_quote_that_binds_something_else_fails() {
    let mut proof = proof();
    // The OutLayer worker's quote with its own collateral: genuine, so Intel vouches for it,
    // but its REPORTDATA is a Task Hash, not the NEAR AI signer and this reply.
    let cycle = proof.cycles[0].clone();
    let outlayer = STANDARD.decode(&cycle.attestation.tdx_quote).unwrap();
    let archive = archived(&mut proof);
    archive.report.intel_quote = outlayer.iter().map(|byte| format!("{byte:02x}")).collect();
    archive.collateral = cycle.collateral;
    archive.collateral_fetched_at = cycle.collateral_fetched_at;

    let report = check(&proof);

    assert!(report.lines.contains(&"PASS nonce 1 ai quote".to_string()));
    assert_eq!(failed(&report), ["nonce 1 ai report data"]);
}

#[test]
fn an_unarchived_signature_is_skipped_with_its_reason() {
    let mut proof = proof();
    proof.cycles[0].ai_signature = None;

    let report = check(&proof);

    assert_eq!(report.failed, 0);
    assert_eq!(
        ai_lines(&report),
        ["SKIP nonce 1 ai signature: not archived"]
    );
}

#[test]
fn a_signature_nearai_no_longer_had_is_skipped_with_its_reason() {
    let mut proof = proof();
    proof.cycles[0].ai_signature = Some(AiArchive::Missing {
        missing: "signature: HTTP 404".into(),
    });

    let report = check(&proof);

    assert_eq!(report.failed, 0);
    assert_eq!(
        ai_lines(&report),
        ["SKIP nonce 1 ai signature: NEAR AI had no record (signature: HTTP 404)"]
    );
}

#[test]
fn a_silent_advisor_has_no_signature_to_check() {
    let silent: Proof =
        serde_json::from_str(include_str!("../fixtures/testnet-proof.json")).unwrap();

    assert!(ai_lines(&check(&silent)).is_empty());
}
