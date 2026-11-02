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
