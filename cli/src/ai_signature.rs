//! Ties the advisor's answer in a decision to the NEAR AI model that gave it. The worker archived
//! the model's signature and the signer's attestation report; this checks them offline:
//! the decision's `resp_sig_hash` is what the signature covers, the signer is the one the report
//! names, the report was made for this reply, and Intel vouches for the report.
//!
//! What this cannot show: the inference image and the model weights. NEAR AI deploys them at
//! runtime, and its attestation records them only by file hash (SPEC §9.1).

use dcap_qvl::verify::QuoteVerifier;
use foundling_strategy::{advisor::MODELS, Decision};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::hex::{decode, encode};
use crate::proof::{AiArchive, AiSignature, Cycle};
use crate::report::Report;

const GOOD_STATUS: &str = "UpToDate";
const SIGNATURE_BYTES: usize = 65;
const ADDRESS_BYTES: usize = 20;
const ADDRESS_FIELD_BYTES: usize = 32;
const ETHEREUM_V_OFFSET: u8 = 27;

pub fn check_cycle(cycle: &Cycle, report: &mut Report) {
    let Ok(decision) = serde_json::from_str::<Decision>(&cycle.decision) else {
        return; // replay already fails a decision that does not parse
    };
    if decision.ai_ref.chat_id.is_empty() {
        return; // a silent advisor made no claim
    }
    let name = format!("nonce {} ai", decision.nonce);
    match &cycle.ai_signature {
        None => report.skip(&format!("{name} signature"), "not archived"),
        Some(AiArchive::Missing { missing }) => report.skip(
            &format!("{name} signature"),
            &format!("NEAR AI had no record ({missing})"),
        ),
        Some(AiArchive::Archived(archive)) => check_archive(&name, &decision, archive, report),
    }
}

fn check_archive(name: &str, decision: &Decision, archive: &AiSignature, report: &mut Report) {
    let reply = &decision.ai_ref.resp_sig_hash;
    let model = decision
        .ai_ref
        .m
        .and_then(|index| MODELS.get(usize::from(index)));
    let mut parts = archive.text.splitn(3, ':');
    let (signed_model, _request, signed_reply) = (parts.next(), parts.next(), parts.next());
    report.check(
        &format!("{name} model"),
        model.is_some_and(|model| signed_model == Some(*model) && archive.model == *model),
        "the signature names another model than ai_ref.m",
    );
    report.check(
        &format!("{name} reply"),
        signed_reply == Some(reply.as_str()),
        "the signature covers another reply",
    );
    let signer = recover_address(&archive.text, &archive.signature);
    report.check(
        &format!("{name} signer"),
        signer.as_deref() == Some(archive.signing_address.to_lowercase().as_str()),
        "the signature does not recover to signing_address",
    );
    let entry = &archive.report;
    report.check(
        &format!("{name} report"),
        entry
            .signing_address
            .eq_ignore_ascii_case(&archive.signing_address)
            && model.is_some_and(|model| entry.model_name == *model)
            && entry.request_nonce == *reply,
        "the report is for another signer, model or reply",
    );
    check_quote(name, archive, report);
}

fn check_quote(name: &str, archive: &AiSignature, report: &mut Report) {
    let Some(quote) = decode(&archive.report.intel_quote) else {
        report.check(&format!("{name} quote"), false, "not hex");
        return;
    };
    let verified = QuoteVerifier::new_prod().verify(
        &quote,
        &archive.collateral,
        archive.collateral_fetched_at,
    );
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
        report.check(&format!("{name} report data"), false, "not a TDX quote");
        return;
    };
    let (address_field, nonce) = td_report.report_data.split_at(ADDRESS_FIELD_BYTES);
    let (address, padding) = address_field.split_at(ADDRESS_BYTES);
    report.check(
        &format!("{name} report data"),
        format!("0x{}", encode(address)).eq_ignore_ascii_case(&archive.signing_address)
            && padding.iter().all(|byte| *byte == 0)
            && encode(nonce) == archive.report.request_nonce,
        "REPORTDATA binds another signer or nonce",
    );
}

/// The `0x` address that signed `text` the way `personal_sign` does (EIP-191), lowercase.
fn recover_address(text: &str, signature: &str) -> Option<String> {
    let bytes = decode(signature.strip_prefix("0x")?)?;
    if bytes.len() != SIGNATURE_BYTES {
        return None;
    }
    let (rs, v) = bytes.split_at(SIGNATURE_BYTES - 1);
    let v = v[0].checked_sub(ETHEREUM_V_OFFSET).unwrap_or(v[0]);
    let mut recovery = RecoveryId::from_byte(v)?;
    let signature = Signature::from_slice(rs).ok()?;
    let low = signature.normalize_s();
    if low != signature {
        // A high s and its low twin recover the same key with the other y parity.
        recovery = RecoveryId::new(!recovery.is_y_odd(), recovery.is_x_reduced());
    }
    let signature = low;
    let prefixed = format!("\x19Ethereum Signed Message:\n{}{text}", text.len());
    let digest = Keccak256::digest(prefixed.as_bytes());
    let key = VerifyingKey::recover_from_prehash(&digest, &signature, recovery).ok()?;
    let point = key.to_sec1_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    Some(format!("0x{}", encode(&hash[hash.len() - ADDRESS_BYTES..])))
}
