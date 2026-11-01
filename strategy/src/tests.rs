use serde_json::json;

use super::*;

const VAULT: &str = "vault.fdl.testnet";
const INPUT: &str = r#"{"nonce":7,"usdc_book":"100000","v":1,"vault":"vault.fdl.testnet","window_buy":"0","window_sell":"0","wnear_book":"500"}"#;
// Computed with Python hashlib, independently of this crate.
const KNOWN_COMMITMENT: &str = "1fbbbf763f52be84f708e45cb8b7a0a5a61de4fcd69bccabc9b708d2befcc6d9";
const KNOWN_DIGEST: &str = "cc4937204b11b6ebf27d23913e8916cd3dac12c715f5a32abce503b9604ea41d";

fn params() -> Params {
    Params {
        risk_on_above: 420_000_000,
        risk_off_below: 400_000_000,
        source_dev_bps: 100,
        buy_usdc: 1_000,
        sell_wnear: 2_000,
    }
}

fn input() -> Input {
    serde_json::from_str(INPUT).unwrap()
}

fn obs(pa: u128, pb: u128) -> Obs {
    Obs {
        pa,
        pb,
        ta: 11,
        tb: 12,
        ai_flag: 0,
        ai_conf: 0,
    }
}

fn salt() -> Vec<u8> {
    (0..32).collect()
}

fn salt_hex() -> String {
    salt().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn secret_json() -> String {
    json!({
        "chain": "testnet",
        "wasm_hash": "bb",
        "salt": salt_hex(),
        "params": {
            "risk_on_above": "420000000",
            "risk_off_below": "400000000",
            "source_dev_bps": "100",
            "buy_usdc": "1000",
            "sell_wnear": "2000",
        },
    })
    .to_string()
}

fn observed(pb: u128) -> impl FnOnce(&Secret) -> Option<Obs> {
    move |_| Some(obs(pb, pb))
}

#[test]
fn a_high_price_is_risk_on_and_buys() {
    let verdict = decide(&params(), &input(), &obs(430_000_000, 431_000_000));

    assert_eq!(verdict.regime, Regime::RiskOn);
    assert_eq!(verdict.action, Action::BuyRisk);
    assert_eq!(verdict.amount_in, 1_000);
    assert_eq!(verdict.ref_price, 431_000_000);
}

#[test]
fn a_low_price_is_risk_off_and_sells() {
    let mut input = input();
    input.wnear_book = 5_000;

    let verdict = decide(&params(), &input, &obs(390_000_000, 390_000_000));

    assert_eq!(verdict.regime, Regime::RiskOff);
    assert_eq!(verdict.action, Action::SellRisk);
    assert_eq!(verdict.amount_in, 2_000);
}

#[test]
fn the_exact_thresholds_count() {
    let on = decide(&params(), &input(), &obs(420_000_000, 420_000_000));
    let off = decide(&params(), &input(), &obs(400_000_000, 400_000_000));

    assert_eq!(on.regime, Regime::RiskOn);
    assert_eq!(off.regime, Regime::RiskOff);
}

#[test]
fn a_price_between_the_thresholds_holds() {
    let verdict = decide(&params(), &input(), &obs(410_000_000, 410_000_000));

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
    assert_eq!(verdict.amount_in, 0);
}

#[test]
fn a_buy_never_asks_for_more_than_the_book() {
    let mut input = input();
    input.usdc_book = 300;

    let verdict = decide(&params(), &input, &obs(430_000_000, 430_000_000));

    assert_eq!(verdict.amount_in, 300);
}

#[test]
fn a_sell_never_asks_for_more_than_the_book() {
    let verdict = decide(&params(), &input(), &obs(390_000_000, 390_000_000));

    assert_eq!(verdict.amount_in, 500);
}

#[test]
fn an_empty_book_holds() {
    let mut input = input();
    input.usdc_book = 0;

    let verdict = decide(&params(), &input, &obs(430_000_000, 430_000_000));

    assert_eq!(verdict.action, Action::None);
    assert_eq!(verdict.amount_in, 0);
}

#[test]
fn two_sources_that_disagree_hold() {
    let verdict = decide(&params(), &input(), &obs(430_000_000, 440_000_000));

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
}

#[test]
fn a_disagreement_never_forces_a_sell() {
    let verdict = decide(&params(), &input(), &obs(300_000_000, 390_000_000));

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
}

#[test]
fn the_widest_allowed_gap_passes() {
    let verdict = decide(&params(), &input(), &obs(426_690_000, 431_000_000));

    assert_eq!(verdict.action, Action::BuyRisk);
}

#[test]
fn a_missing_price_holds() {
    let verdict = decide(&params(), &input(), &obs(0, 0));

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn a_huge_price_holds_instead_of_overflowing() {
    let verdict = decide(&params(), &input(), &obs(u128::MAX, u128::MAX));

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn the_pool_price_alone_cannot_trigger_a_trade() {
    let verdict = decide(&params(), &input(), &obs(421_000_000, 418_000_000));

    assert_eq!(verdict.regime, Regime::Undetermined);
}

#[test]
fn an_ai_flag_blocks_a_buy() {
    let mut flagged = obs(430_000_000, 430_000_000);
    flagged.ai_flag = 1;

    let verdict = decide(&params(), &input(), &flagged);

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn an_ai_flag_cannot_stop_a_sell() {
    let mut flagged = obs(390_000_000, 390_000_000);
    flagged.ai_flag = 1;

    let verdict = decide(&params(), &input(), &flagged);

    assert_eq!(verdict.action, Action::SellRisk);
}

#[test]
fn the_commitment_matches_an_independent_implementation() {
    let value = commitment("testnet", VAULT, "bb", &params(), &salt());

    assert_eq!(value, KNOWN_COMMITMENT);
}

#[test]
fn the_commitment_changes_with_each_field() {
    let base = commitment("testnet", VAULT, "bb", &params(), &salt());
    let mut other_params = params();
    other_params.buy_usdc += 1;

    assert_ne!(base, commitment("mainnet", VAULT, "bb", &params(), &salt()));
    assert_ne!(
        base,
        commitment("testnet", "x.testnet", "bb", &params(), &salt())
    );
    assert_ne!(base, commitment("testnet", VAULT, "cc", &params(), &salt()));
    assert_ne!(
        base,
        commitment("testnet", VAULT, "bb", &other_params, &salt())
    );
    assert_ne!(
        base,
        commitment("testnet", VAULT, "bb", &params(), &[9; 32])
    );
}

#[test]
fn field_boundaries_cannot_be_shifted() {
    let first = commitment("test", "net", "bb", &params(), &salt());
    let second = commitment("testn", "et", "bb", &params(), &salt());

    assert_ne!(first, second);
}

#[test]
fn the_inputs_digest_matches_an_independent_implementation() {
    let digest = inputs_digest(r#"{"v":1}"#, &obs(430_000_000, 431_000_000), "sig");

    assert_eq!(digest, KNOWN_DIGEST);
}

#[test]
fn a_run_answers_for_its_own_cycle() {
    let decision = respond(INPUT, Some(&secret_json()), observed(431_000_000)).unwrap();

    assert_eq!(decision.v, 1);
    assert_eq!(decision.vault, VAULT);
    assert_eq!(decision.nonce, 7);
    assert_eq!(decision.chain, "testnet");
    assert_eq!(decision.wasm_hash, "bb");
    assert_eq!(decision.action, Action::BuyRisk);
    assert_eq!(decision.commitment, KNOWN_COMMITMENT);
    let expected = inputs_digest(INPUT, &obs(431_000_000, 431_000_000), "");
    assert_eq!(decision.inputs_digest, expected);
}

#[test]
fn the_decision_has_the_wire_shape_the_vault_reads() {
    let decision = respond(INPUT, Some(&secret_json()), observed(431_000_000)).unwrap();

    let wire = serde_json::to_value(&decision).unwrap();

    assert_eq!(wire["action"], "buy_risk");
    assert_eq!(wire["regime"], "risk_on");
    assert_eq!(wire["amount_in"], "1000");
    assert_eq!(wire["ref_price"], "431000000");
    assert_eq!(wire["obs"]["pa"], "431000000");
    assert_eq!(wire["obs"]["ta"], 11);
}

#[test]
fn a_decision_fits_the_target_size() {
    let long_vault = format!("{}.fdl-m3-738321.testnet", "v".repeat(20));
    let input = INPUT.replace(VAULT, &long_vault);
    let hash = "a".repeat(64);
    let secret = secret_json().replace("\"bb\"", &format!("\"{hash}\""));

    let decision = respond(&input, Some(&secret), observed(431_000_000)).unwrap();

    assert!(serde_json::to_vec(&decision).unwrap().len() <= 600);
}

#[test]
fn no_secret_gives_a_hold_the_vault_will_refuse() {
    let decision = respond(INPUT, None, observed(431_000_000)).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.amount_in, 0);
    assert_eq!(decision.commitment, "");
    assert_eq!(decision.wasm_hash, "");
    assert_eq!(decision.nonce, 7);
}

#[test]
fn an_empty_secret_is_no_secret() {
    let decision = respond(INPUT, Some(""), observed(431_000_000)).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.commitment, "");
}

#[test]
fn a_broken_secret_is_no_secret() {
    let decision = respond(INPUT, Some("not json"), observed(431_000_000)).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.commitment, "");
}

#[test]
fn a_secret_with_an_extra_field_is_refused() {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["params"]["extra"] = json!("1");

    let decision = respond(INPUT, Some(&secret.to_string()), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
}

#[test]
fn a_short_salt_is_no_secret() {
    let secret = secret_json().replace(&salt_hex(), "00ff");

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
    assert_eq!(decision.action, Action::None);
}

#[test]
fn a_salt_that_is_not_hex_is_no_secret() {
    let secret = secret_json().replace(&salt_hex(), &"zz".repeat(32));

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
}

#[test]
fn no_observation_holds_but_still_proves_the_secret() {
    let decision = respond(INPUT, Some(&secret_json()), |_| None).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.regime, Regime::Undetermined);
    assert_eq!(decision.commitment, KNOWN_COMMITMENT);
}

#[test]
fn a_secret_never_reaches_the_answer() {
    let decision = respond(INPUT, Some(&secret_json()), observed(431_000_000)).unwrap();

    let wire = serde_json::to_string(&decision).unwrap();

    assert!(!wire.contains(&salt_hex()));
    assert!(!wire.contains("risk_on_above"));
}

#[test]
fn input_of_another_version_is_refused() {
    let input = INPUT.replace(r#""v":1"#, r#""v":2"#);

    assert_eq!(respond(&input, None, |_| None), Err(BadInput));
}

#[test]
fn broken_input_is_refused() {
    assert_eq!(respond("not json", None, |_| None), Err(BadInput));
}
