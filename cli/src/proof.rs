//! One proof file per vault. `tools/fetch_proof.py` builds it from public sources, so nothing
//! here is taken on the creator's word: anyone can fetch the same file again.

use dcap_qvl::QuoteCollateralV3;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub chain: String,
    pub vault: String,
    pub wasm_hash: String,
    pub commitment: String,
    pub secrets_ref: String,
    /// Empty until `reveal`.
    #[serde(default)]
    pub opening: Option<Opening>,
    pub approved_measurements: Vec<Measurements>,
    pub cycles: Vec<Cycle>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub params: String,
    pub salt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Measurements {
    pub mrtd: String,
    pub rtmr0: String,
    pub rtmr1: String,
    pub rtmr2: String,
    pub rtmr3: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cycle {
    pub tx: String,
    /// The bytes the vault sent, as they stand in the `request_execution` receipt.
    pub input_data: String,
    /// The text of the `decision` event.
    pub decision: String,
    pub attestation: Attestation,
    pub collateral: QuoteCollateralV3,
    /// Unix seconds. The quote is judged at this time, so the same file always gives the same
    /// answer, and a later TCB recall does not rewrite an old proof.
    pub collateral_fetched_at: u64,
    /// What the worker archived of the NEAR AI reply behind `ai_ref`; absent when there was no
    /// chat or no archive key.
    #[serde(default)]
    pub ai_signature: Option<AiArchive>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AiArchive {
    Archived(Box<AiSignature>),
    /// NEAR AI answered 404: it no longer had the signature or the report.
    Missing {
        missing: String,
    },
}

/// `/v1/signature/<chat_id>` and the signer's entry in `/v1/attestation/report`, the report
/// asked with the reply hash as its nonce.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSignature {
    pub model: String,
    /// `<model>:<request_hash>:<response_hash>`, what the model's TEE signed.
    pub text: String,
    /// 65 bytes, hex with `0x`: r, s and the recovery byte.
    pub signature: String,
    pub signing_address: String,
    pub signing_algo: String,
    pub report: ModelReport,
    pub collateral: QuoteCollateralV3,
    pub collateral_fetched_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelReport {
    pub model_name: String,
    pub signing_address: String,
    pub request_nonce: String,
    /// Hex, unlike OutLayer's base64.
    pub intel_quote: String,
    /// dstack's measured boot log: RTMR3 replays from its `imr` 3 events, among them `app-id`.
    pub event_log: Vec<LogEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogEvent {
    pub imr: u32,
    pub event_type: u32,
    /// Hex SHA-384; empty for dstack's runtime events, whose digest comes from the fields below.
    pub digest: String,
    pub event: String,
    /// Hex.
    pub event_payload: String,
}

/// The reply of `/attestations/by-tx/<tx>`. Unknown fields pass on purpose: the Task Hash
/// decides what counts, and OutLayer may add labels beside it.
#[derive(Debug, Clone, Deserialize)]
pub struct Attestation {
    pub task_id: i64,
    pub task_type: String,
    pub tdx_quote: String,
    pub worker_measurement: String,
    pub caller_account_id: String,
    pub transaction_hash: String,
    pub block_height: u64,
    pub build_target: String,
    pub wasm_hash: String,
    pub executed_wasm_sha256: String,
    pub input_hash: String,
    pub output_hash: String,
    pub secrets_ref: String,
    pub attached_usd: String,
    pub timestamp: i64,
}
