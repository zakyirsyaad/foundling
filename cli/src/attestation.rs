//! Ties one on-chain decision to a TDX quote. The chain of trust runs from Intel's root to the
//! quote, from the quote's REPORTDATA to the Task Hash, and from there to the bytes on chain.
//!
//! What this cannot show: the vault does not verify quotes, so a false result signed by
//! OutLayer's operator would still have been accepted on chain. This catches it afterwards.

use base64::{engine::general_purpose::STANDARD, Engine};
use dcap_qvl::quote::TDReport10;
use dcap_qvl::verify::QuoteVerifier;
use sha2::{Digest, Sha256};

use crate::hex::encode;
use crate::proof::{Attestation, Cycle, Measurements, Proof};
use crate::report::Report;

const GOOD_STATUS: &str = "UpToDate";
const TASK_HASH_BYTES: usize = 32;

/// Field for field as OutLayer's worker builds it in `generate_task_attestation`. Its optional
/// `repo`, `commit` and `project_id` are absent here because the vault pins a `WasmUrl`.
pub fn task_hash(attestation: &Attestation) -> [u8; TASK_HASH_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(attestation.task_type.as_bytes());
    hasher.update(attestation.task_id.to_le_bytes());
    hasher.update(attestation.build_target.as_bytes());
    hasher.update(attestation.wasm_hash.as_bytes());
    hasher.update(attestation.input_hash.as_bytes());
    hasher.update(attestation.output_hash.as_bytes());
    hasher.update(attestation.block_height.to_le_bytes());
    hasher.update(attestation.caller_account_id.as_bytes());
    hasher.update(attestation.secrets_ref.as_bytes());
    hasher.update(attestation.timestamp.to_le_bytes());
    hasher.update(attestation.attached_usd.as_bytes());
    hasher.finalize().into()
}

fn sha256_hex(text: &str) -> String {
    encode(&Sha256::digest(text.as_bytes()))
}

fn measurements_of(report: &TDReport10) -> Measurements {
    Measurements {
        mrtd: encode(&report.mr_td),
        rtmr0: encode(&report.rt_mr0),
        rtmr1: encode(&report.rt_mr1),
        rtmr2: encode(&report.rt_mr2),
        rtmr3: encode(&report.rt_mr3),
    }
}

pub fn check_cycle(proof: &Proof, cycle: &Cycle, report: &mut Report) {
    let attestation = &cycle.attestation;
    let name = format!("tx {}", cycle.tx);
    report.check(
        &format!("{name} attestation names this tx"),
        attestation.transaction_hash == cycle.tx,
        &attestation.transaction_hash,
    );
    report.check(
        &format!("{name} input hash"),
        attestation.input_hash == sha256_hex(&cycle.input_data),
        "the run saw other input bytes",
    );
    report.check(
        &format!("{name} output hash"),
        attestation.output_hash == sha256_hex(&cycle.decision),
        "the run gave other output bytes",
    );
    report.check(
        &format!("{name} wasm hash"),
        attestation.wasm_hash == proof.wasm_hash
            && attestation.executed_wasm_sha256 == proof.wasm_hash,
        "the run used another binary",
    );
    report.check(
        &format!("{name} secrets"),
        attestation.secrets_ref == proof.secrets_ref,
        &attestation.secrets_ref,
    );

    let Ok(quote) = STANDARD.decode(&attestation.tdx_quote) else {
        report.check(&format!("{name} quote"), false, "not base64");
        return;
    };
    let verified =
        QuoteVerifier::new_prod().verify(&quote, &cycle.collateral, cycle.collateral_fetched_at);
    let verified = match verified {
        Ok(verified) => verified,
        Err(error) => {
            report.check(&format!("{name} quote"), false, &error.to_string());
            return;
        }
    };
    report.check(
        &format!("{name} quote"),
        verified.status == GOOD_STATUS,
        &format!("TCB status {}", verified.status),
    );
    let Some(td_report) = verified.report.as_td10() else {
        report.check(&format!("{name} TD report"), false, "not a TDX quote");
        return;
    };
    let (bound, rest) = td_report.report_data.split_at(TASK_HASH_BYTES);
    report.check(
        &format!("{name} Task Hash"),
        bound == task_hash(attestation) && rest.iter().all(|byte| *byte == 0),
        "REPORTDATA does not cover these fields",
    );
    let measured = measurements_of(td_report);
    report.check(
        &format!("{name} worker measurement"),
        attestation.worker_measurement == measured.rtmr3,
        "the reply names another RTMR3",
    );
    report.check(
        &format!("{name} approved measurements"),
        proof.approved_measurements.contains(&measured),
        "this worker is not on the approved list",
    );
}
