use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, PromiseError};

use crate::decision::{decode, Action, CycleFailure, Expected, MAX_DECISION_BYTES};

const COMMITMENT: &str = "aa";
const WASM_HASH: &str = "bb";

fn vault() -> AccountId {
    "vault.owner.near".parse().unwrap()
}

fn expected() -> Expected<'static> {
    Expected {
        vault: "vault.owner.near",
        chain: "testnet",
        nonce: 7,
        commitment: COMMITMENT,
        wasm_hash: WASM_HASH,
    }
}

fn wire() -> serde_json::Value {
    json!({
        "v": 1,
        "vault": vault(),
        "chain": "testnet",
        "nonce": 7,
        "regime": "risk_on",
        "action": "buy_risk",
        "amount_in": "1000",
        "ref_price": "450000000",
        "commitment": COMMITMENT,
        "inputs_digest": "cc",
        "obs": {"pa": "1", "pb": "2", "ta": 1, "tb": 2, "ai_flag": 0, "ai_conf": 0},
        "ai_ref": {"chat_id": "x", "resp_sig_hash": "y"},
        "wasm_hash": WASM_HASH,
    })
}

fn bytes(value: &serde_json::Value) -> Result<Vec<u8>, PromiseError> {
    Ok(value.to_string().into_bytes())
}

fn with(field: &str, value: serde_json::Value) -> Result<Vec<u8>, PromiseError> {
    let mut decision = wire();
    decision[field] = value;
    bytes(&decision)
}

#[test]
fn a_valid_buy_is_read() {
    let decision = decode(&bytes(&wire()), &expected()).unwrap().unwrap();

    assert_eq!(decision.action, Action::BuyRisk);
    assert_eq!(decision.amount_in, U128(1000));
    assert_eq!(decision.ref_price, U128(450_000_000));
}

#[test]
fn a_valid_sell_is_read() {
    let decision = decode(&with("action", json!("sell_risk")), &expected())
        .unwrap()
        .unwrap();

    assert_eq!(decision.action, Action::SellRisk);
}

#[test]
fn no_action_means_hold() {
    let result = decode(&with("action", json!("none")), &expected());

    assert_eq!(result, Ok(None));
}

#[test]
fn null_from_outlayer_is_a_failed_cycle() {
    let result = decode(&Ok(b"null".to_vec()), &expected());

    assert_eq!(result, Err(CycleFailure::NullResult));
}

#[test]
fn a_failed_request_is_a_failed_cycle() {
    let result = decode(&Err(PromiseError::Failed), &expected());

    assert_eq!(result, Err(CycleFailure::RequestFailed));
}

#[test]
fn an_oversized_result_is_a_failed_cycle() {
    let result = decode(
        &Err(PromiseError::TooLong(MAX_DECISION_BYTES + 1)),
        &expected(),
    );

    assert_eq!(result, Err(CycleFailure::Oversize));
}

#[test]
fn garbage_is_a_failed_cycle() {
    let result = decode(&Ok(b"not json".to_vec()), &expected());

    assert_eq!(result, Err(CycleFailure::Malformed));
}

#[test]
fn a_missing_field_is_a_failed_cycle() {
    let mut decision = wire();
    decision.as_object_mut().unwrap().remove("amount_in");

    assert_eq!(
        decode(&bytes(&decision), &expected()),
        Err(CycleFailure::Malformed)
    );
}

#[test]
fn an_unknown_action_is_a_failed_cycle() {
    let result = decode(&with("action", json!("sell_everything")), &expected());

    assert_eq!(result, Err(CycleFailure::Malformed));
}

#[test]
fn a_wrong_version_is_a_failed_cycle() {
    let result = decode(&with("v", json!(2)), &expected());

    assert_eq!(result, Err(CycleFailure::Malformed));
}

#[test]
fn another_nonce_is_refused() {
    let result = decode(&with("nonce", json!(6)), &expected());

    assert_eq!(result, Err(CycleFailure::NonceMismatch));
}

#[test]
fn another_vault_is_refused() {
    let result = decode(&with("vault", json!("other.near")), &expected());

    assert_eq!(result, Err(CycleFailure::NonceMismatch));
}

#[test]
fn another_chain_is_refused() {
    let result = decode(&with("chain", json!("mainnet")), &expected());

    assert_eq!(result, Err(CycleFailure::NonceMismatch));
}

#[test]
fn another_commitment_is_refused() {
    let result = decode(&with("commitment", json!("dd")), &expected());

    assert_eq!(result, Err(CycleFailure::CommitmentMismatch));
}

#[test]
fn another_wasm_hash_is_refused() {
    let result = decode(&with("wasm_hash", json!("dd")), &expected());

    assert_eq!(result, Err(CycleFailure::CommitmentMismatch));
}

#[test]
fn a_hold_still_has_to_belong_to_this_cycle() {
    let mut decision = wire();
    decision["action"] = json!("none");
    decision["nonce"] = json!(6);

    assert_eq!(
        decode(&bytes(&decision), &expected()),
        Err(CycleFailure::NonceMismatch)
    );
}

#[test]
fn each_failure_has_its_spec_code() {
    let codes = [
        (CycleFailure::NullResult, "NULL_RESULT"),
        (CycleFailure::RequestFailed, "REQUEST_FAILED"),
        (CycleFailure::Malformed, "MALFORMED"),
        (CycleFailure::Oversize, "OVERSIZE"),
        (CycleFailure::CommitmentMismatch, "COMMITMENT_MISMATCH"),
        (CycleFailure::NonceMismatch, "NONCE_MISMATCH"),
    ];

    for (failure, code) in codes {
        assert_eq!(failure.code(), code);
    }
}
