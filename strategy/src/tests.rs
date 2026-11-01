use serde_json::json;

use super::*;

const VAULT: &str = "vault.owner.near";
// The vault test `the_input_matches_the_fixture_the_strategy_reads` pins the same file.
const INPUT: &str = include_str!("../fixtures/input.json");
// Computed with Python hashlib, independently of this crate.
const KNOWN_COMMITMENT: &str = "496513afc2402651f0e0402133faf5c0f650395f6eae08d0561ec12825795396";
const KNOWN_DIGEST: &str = "cc4937204b11b6ebf27d23913e8916cd3dac12c715f5a32abce503b9604ea41d";
const USDC: u128 = 1_000_000;
const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;
const HIGH: u128 = 450_000_000;
const LOW: u128 = 390_000_000;

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
    let mut input: Input = serde_json::from_str(INPUT).unwrap();
    input.usdc_book = 100_000;
    input.wnear_book = 500;
    input
}

fn large_params() -> Params {
    Params {
        buy_usdc: 1_000 * USDC,
        sell_wnear: 4 * WNEAR,
        ..params()
    }
}

fn sell_size(wnear_book: u128, window_sell: u128) -> u128 {
    let mut input = input();
    input.wnear_book = wnear_book;
    input.window_sell = window_sell;
    decide(&large_params(), &input, &obs(LOW, LOW)).amount_in
}

fn buy_size(usdc_book: u128, wnear_book: u128, window_buy: u128) -> u128 {
    let mut input = input();
    input.usdc_book = usdc_book;
    input.wnear_book = wnear_book;
    input.window_buy = window_buy;
    decide(&large_params(), &input, &obs(HIGH, HIGH)).amount_in
}

fn secret_with_param(field: &str, value: &str) -> String {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["params"][field] = json!(value);
    secret.to_string()
}

fn refuses_param(field: &str, value: &str) {
    let secret = secret_with_param(field, value);

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
    assert_eq!(decision.action, Action::None);
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
    input.limits.cap_bps = 10_000;
    input.limits.epoch_cap_bps = 10_000;
    input.limits.max_risk_bps = 10_000;

    let verdict = decide(&params(), &input, &obs(430_000_000, 430_000_000));

    assert_eq!(verdict.amount_in, 300);
}

#[test]
fn a_sell_stays_inside_half_of_a_large_book() {
    assert_eq!(sell_size(5 * WNEAR, 0), 5 * WNEAR / 2);
    assert_eq!(sell_size(6 * WNEAR, 0), 3 * WNEAR);
    assert_eq!(sell_size(7 * WNEAR, 0), 7 * WNEAR / 2);
    assert_eq!(sell_size(8 * WNEAR, 0), 4 * WNEAR);
}

#[test]
fn a_sell_never_passes_the_absolute_cap() {
    assert_eq!(sell_size(20 * WNEAR, 0), 4 * WNEAR);
}

#[test]
fn a_book_under_the_cap_can_be_swept_whole() {
    assert_eq!(sell_size(3 * WNEAR, 0), 3 * WNEAR);
    assert_eq!(sell_size(4 * WNEAR, 0), 4 * WNEAR);
}

#[test]
fn a_sell_stays_inside_the_window() {
    assert_eq!(sell_size(8 * WNEAR, 6 * WNEAR), 2 * WNEAR);
}

#[test]
fn a_spent_sell_window_holds() {
    let mut input = input();
    input.wnear_book = 8 * WNEAR;
    input.window_sell = 8 * WNEAR;

    let verdict = decide(&large_params(), &input, &obs(LOW, LOW));

    assert_eq!(verdict.action, Action::None);
    assert_eq!(verdict.amount_in, 0);
}

#[test]
fn a_buy_stays_inside_its_share_of_nav() {
    assert_eq!(buy_size(100 * USDC, 0, 0), 10 * USDC);
}

#[test]
fn a_buy_never_passes_the_absolute_cap() {
    assert_eq!(buy_size(1_000 * USDC, 0, 0), 15 * USDC);
}

#[test]
fn a_buy_stays_inside_the_window() {
    assert_eq!(buy_size(1_000 * USDC, 0, 20 * USDC), 10 * USDC);
}

#[test]
fn a_spent_buy_window_holds() {
    assert_eq!(buy_size(1_000 * USDC, 0, 30 * USDC), 0);
}

#[test]
fn a_buy_counts_wnear_at_the_low_edge_of_the_price_band() {
    // 2 wNEAR at 4.5 is 9 USDC, valued at 8.82 inside the 200 bps band.
    assert_eq!(buy_size(100 * USDC, 2 * WNEAR, 0), 10_882_000);
}

#[test]
fn a_buy_stops_at_the_exposure_limit() {
    // 10 wNEAR is 45 USDC: NAV 94.1 at the low edge, exposure 45.9 at the high edge.
    assert_eq!(buy_size(50 * USDC, 10 * WNEAR, 0), 1_150_000);
}

#[test]
fn full_exposure_holds() {
    assert_eq!(buy_size(40 * USDC, 10 * WNEAR, 0), 0);
}

#[test]
fn a_price_too_large_to_value_holds() {
    let mut input = input();
    input.wnear_book = 10 * WNEAR;
    let huge = 10u128.pow(30);

    let verdict = decide(&large_params(), &input, &obs(huge, huge));

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn a_zero_scale_holds() {
    let mut input = input();
    input.limits.decimal_scale = 0;

    let verdict = decide(&large_params(), &input, &obs(HIGH, HIGH));

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn canonical_params_are_fixed_text() {
    let expected = r#"{"buy_usdc":"1000","risk_off_below":"400000000","risk_on_above":"420000000","sell_wnear":"2000","source_dev_bps":"100"}"#;

    assert_eq!(params().canonical(), expected);
}

#[test]
fn canonical_obs_are_fixed_text() {
    let expected = r#"{"ai_conf":0,"ai_flag":0,"pa":"430000000","pb":"431000000","ta":11,"tb":12}"#;

    assert_eq!(obs(430_000_000, 431_000_000).canonical(), expected);
}

#[test]
fn thresholds_that_touch_are_refused() {
    refuses_param("risk_off_below", "420000000");
}

#[test]
fn thresholds_in_the_wrong_order_are_refused() {
    refuses_param("risk_on_above", "300000000");
}

#[test]
fn a_zero_buy_size_is_refused() {
    refuses_param("buy_usdc", "0");
}

#[test]
fn a_zero_sell_size_is_refused() {
    refuses_param("sell_wnear", "0");
}

#[test]
fn a_zero_source_gap_is_refused() {
    refuses_param("source_dev_bps", "0");
}

#[test]
fn a_source_gap_above_everything_is_refused() {
    refuses_param("source_dev_bps", "10001");
}

#[cfg(not(feature = "rehearsal"))]
#[test]
fn a_normal_build_refuses_a_secret_with_rehearsal_prices() {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["rehearsal_obs"] = serde_json::to_value(obs(431_000_000, 431_000_000)).unwrap();

    let decision = respond(INPUT, Some(&secret.to_string()), |_| None).unwrap();

    assert_eq!(decision.commitment, "");
}

#[cfg(feature = "rehearsal")]
fn secret_on_chain(chain: &str) -> String {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["chain"] = json!(chain);
    secret["rehearsal_obs"] = serde_json::to_value(obs(431_000_000, 431_000_000)).unwrap();
    secret.to_string()
}

#[cfg(feature = "rehearsal")]
#[test]
fn rehearsal_prices_work_on_testnet() {
    let secret = secret_on_chain("testnet");

    let decision = respond(INPUT, Some(&secret), rehearsal_observe).unwrap();

    assert_eq!(decision.action, Action::BuyRisk);
}

#[cfg(feature = "rehearsal")]
#[test]
fn rehearsal_prices_are_ignored_off_testnet() {
    let secret = secret_on_chain("mainnet");

    let decision = respond(INPUT, Some(&secret), rehearsal_observe).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.obs, Obs::default());
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
    assert_eq!(decision.nonce, 1);
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
    assert_eq!(decision.nonce, 1);
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
