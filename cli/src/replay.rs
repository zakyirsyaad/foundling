//! Reads a decision back from chain data and re-runs the rule that made it. This covers what
//! the run reported, not whether the prices were true: `tools/recheck_obs.py` compares `obs`
//! with the public sources.
//!
//! `decide` is compiled in, so this binary has to come from the commit that built the vault's
//! `wasm_hash`. Any other commit answers for its own rule, and a difference shows as a failure.

use foundling_strategy::{commitment, decide, inputs_digest, Decision, Input, Params};

use crate::hex::{decode, SALT_BYTES};
use crate::proof::{Cycle, Opening, Proof};
use crate::report::Report;

const DECISION_VERSION: u32 = 1;

/// The parameters, once they are proven to be the ones the vault was born with.
pub fn open_params(proof: &Proof, report: &mut Report) -> Option<Params> {
    let Some(Opening { params, salt }) = &proof.opening else {
        report.skip("commitment", "the parameters are not revealed yet");
        return None;
    };
    let parsed: Option<Params> = serde_json::from_str(params).ok();
    let Some(parsed) = parsed.filter(|parsed| parsed.canonical() == *params) else {
        report.check("commitment", false, "the parameters are not canonical");
        return None;
    };
    let Some(salt) = decode(salt).filter(|salt| salt.len() == SALT_BYTES) else {
        report.check("commitment", false, "the salt is not 32 bytes of hex");
        return None;
    };
    let opened = commitment(&proof.chain, &proof.vault, &proof.wasm_hash, &parsed, &salt);
    let holds = opened == proof.commitment;
    report
        .check("commitment", holds, "the opening gives another commitment")
        .then_some(parsed)
}

/// True only when the rule was re-run and gave the same answer.
pub fn check_cycle(
    proof: &Proof,
    cycle: &Cycle,
    params: Option<&Params>,
    report: &mut Report,
) -> bool {
    let name = format!("tx {}", cycle.tx);
    let Ok(decision) = serde_json::from_str::<Decision>(&cycle.decision) else {
        report.check(&format!("{name} decision"), false, "unreadable");
        return false;
    };
    let Ok(input) = serde_json::from_str::<Input>(&cycle.input_data) else {
        report.check(&format!("{name} input"), false, "unreadable");
        return false;
    };
    let name = format!("nonce {}", decision.nonce);
    report.check(
        &format!("{name} binding"),
        is_bound(proof, &decision, &input),
        "vault, chain, nonce, hash or commitment differ",
    );
    let digest = inputs_digest(
        &cycle.input_data,
        &decision.obs,
        &decision.ai_ref.resp_sig_hash,
    );
    report.check(
        &format!("{name} inputs_digest"),
        digest == decision.inputs_digest,
        "the digest does not cover these inputs",
    );
    let Some(params) = params else {
        report.skip(&format!("{name} replay"), "needs the revealed parameters");
        return false;
    };
    let verdict = decide(params, &input, &decision.obs);
    let reproduced = verdict.regime == decision.regime
        && verdict.action == decision.action
        && verdict.amount_in == decision.amount_in
        && verdict.ref_price == decision.ref_price;
    report.check(
        &format!("{name} replay"),
        reproduced,
        &format!("the rule gives {verdict:?}"),
    )
}

fn is_bound(proof: &Proof, decision: &Decision, input: &Input) -> bool {
    decision.v == DECISION_VERSION
        && decision.nonce == input.nonce
        && decision.vault == proof.vault
        && input.vault == proof.vault
        && decision.chain == proof.chain
        && decision.wasm_hash == proof.wasm_hash
        && decision.commitment == proof.commitment
}
