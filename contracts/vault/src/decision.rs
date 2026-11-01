//! Decision v1, the strategy WASM's answer. Only its shape and its binding to this cycle
//! are checked here; caps and routes are enforced later by the contract.

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::{near, PromiseError};

/// Hard limit of the yield resume payload.
pub const MAX_DECISION_BYTES: usize = 1024;
const DECISION_VERSION: u32 = 1;
const NULL_RESULT: &[u8] = b"null";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    None,
    BuyRisk,
    SellRisk,
}

#[near(serializers = [json])]
struct WireDecision {
    v: u32,
    vault: String,
    chain: String,
    nonce: u64,
    action: Action,
    amount_in: U128,
    ref_price: U128,
    commitment: String,
    wasm_hash: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub action: Action,
    pub amount_in: U128,
    pub ref_price: U128,
}

pub struct Expected<'a> {
    pub vault: &'a str,
    pub chain: &'a str,
    pub nonce: u64,
    pub commitment: &'a str,
    pub wasm_hash: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CycleFailure {
    NullResult,
    RequestFailed,
    Malformed,
    Oversize,
    CommitmentMismatch,
    NonceMismatch,
}

impl CycleFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::NullResult => "NULL_RESULT",
            Self::RequestFailed => "REQUEST_FAILED",
            Self::Malformed => "MALFORMED",
            Self::Oversize => "OVERSIZE",
            Self::CommitmentMismatch => "COMMITMENT_MISMATCH",
            Self::NonceMismatch => "NONCE_MISMATCH",
        }
    }
}

/// `Ok(None)` is a hold: the strategy answered this cycle and chose not to trade.
pub fn decode(
    result: &Result<Vec<u8>, PromiseError>,
    expected: &Expected,
) -> Result<Option<Decision>, CycleFailure> {
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(PromiseError::TooLong(_)) => return Err(CycleFailure::Oversize),
        Err(_) => return Err(CycleFailure::RequestFailed),
    };
    if bytes.as_slice() == NULL_RESULT {
        return Err(CycleFailure::NullResult);
    }
    let wire: WireDecision = serde_json::from_slice(bytes).map_err(|_| CycleFailure::Malformed)?;
    if wire.v != DECISION_VERSION {
        return Err(CycleFailure::Malformed);
    }
    if wire.nonce != expected.nonce || wire.vault != expected.vault || wire.chain != expected.chain
    {
        return Err(CycleFailure::NonceMismatch);
    }
    if wire.commitment != expected.commitment || wire.wasm_hash != expected.wasm_hash {
        return Err(CycleFailure::CommitmentMismatch);
    }
    if wire.action == Action::None {
        return Ok(None);
    }
    Ok(Some(Decision {
        action: wire.action,
        amount_in: wire.amount_in,
        ref_price: wire.ref_price,
    }))
}
