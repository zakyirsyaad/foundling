use serde_json::json;

use super::*;

const VAULT: &str = "vault.owner.near";
// The vault test `the_input_matches_the_fixture_the_strategy_reads` pins the same file.
const INPUT: &str = include_str!("../fixtures/input.json");
// Computed with Python hashlib, independently of this crate.
const KNOWN_COMMITMENT: &str = "8838dc3c07993aa1f1488bbe99b5c55aafcc86de7445eaf35639f1dd21a4c2f4";
const KNOWN_DIGEST: &str = "cc4937204b11b6ebf27d23913e8916cd3dac12c715f5a32abce503b9604ea41d";
const USDC: u128 = 1_000_000;
const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;
const HIGH: u128 = 450_000_000;
const LOW: u128 = 390_000_000;
/// A full-cap sell with every field at its longest is 736 bytes; the vault's hard limit is 1024.
const DECISION_TARGET_BYTES: usize = 768;
const PROMPT: &str = "Classify the headlines.";
const TIME_OF_OBS: u64 = 12;
const MAX_ACCOUNT_BYTES: usize = 64;
const HASH_HEX_BYTES: usize = 64;
const MAX_CHAT_ID_BYTES: usize = 64;
const FIXTURE_NOW: u64 = 1_800_000_000;

fn params() -> Params {
    Params {
        risk_on_above: 420_000_000,
        risk_off_below: 400_000_000,
        source_dev_bps: 100,
        buy_usdc: 1_000,
        sell_wnear: 2_000,
        prompt: PROMPT.into(),
    }
}

fn input() -> Input {
    let mut input: Input = serde_json::from_str(INPUT).unwrap();
    input.usdc_book = 100_000;
    input.wnear_book = 500;
    input.now = TIME_OF_OBS;
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
            "prompt": PROMPT,
        },
    })
    .to_string()
}

/// A reading as fresh as the fixture's `now`.
fn fresh_obs(price: u128) -> Obs {
    Obs {
        ta: FIXTURE_NOW,
        tb: FIXTURE_NOW,
        ..obs(price, price)
    }
}

fn observed(pb: u128) -> impl FnOnce(&Secret, &Input) -> Option<Observed> {
    move |_, _| Some(fresh_obs(pb).into())
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
    let expected = r#"{"buy_usdc":"1000","prompt":"Classify the headlines.","risk_off_below":"400000000","risk_on_above":"420000000","sell_wnear":"2000","source_dev_bps":"100"}"#;

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

    let decision = respond(INPUT, Some(&secret.to_string()), |_, _| None).unwrap();

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
fn rehearsal_prices_take_the_clock_of_the_vault() {
    let secret = secret_on_chain("testnet");

    let decision = respond(INPUT, Some(&secret), rehearsal_observe).unwrap();

    assert_eq!(decision.obs.ta, FIXTURE_NOW);
    assert_eq!(decision.obs.tb, FIXTURE_NOW);
}

#[cfg(feature = "rehearsal")]
#[test]
fn rehearsal_prices_are_ignored_off_testnet() {
    let secret = secret_on_chain("mainnet");

    let decision = respond(INPUT, Some(&secret), rehearsal_observe).unwrap();

    assert_eq!(decision.action, Action::None);
    assert_eq!(decision.obs, Obs::unread());
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
fn a_silent_advisor_holds_a_buy() {
    let mut silent = obs(430_000_000, 430_000_000);
    silent.ai_flag = AI_SILENT;

    let verdict = decide(&params(), &input(), &silent);

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
}

#[test]
fn a_silent_advisor_holds_a_sell() {
    let mut silent = obs(390_000_000, 390_000_000);
    silent.ai_flag = AI_SILENT;

    let verdict = decide(&params(), &input(), &silent);

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
}

#[test]
fn an_unknown_ai_flag_holds() {
    let mut unknown = obs(390_000_000, 390_000_000);
    unknown.ai_flag = u8::MAX;

    let verdict = decide(&params(), &input(), &unknown);

    assert_eq!(verdict.action, Action::None);
}

fn input_at(now: u64) -> Input {
    Input { now, ..input() }
}

fn seen_at(ta: u64, tb: u64) -> Obs {
    Obs {
        ta,
        tb,
        ..obs(390_000_000, 390_000_000)
    }
}

#[test]
fn a_stale_trade_holds() {
    let stale = seen_at(10_000, 10_000 - MAX_SOURCE_AGE_SECONDS - 1);

    let verdict = decide(&params(), &input_at(10_000), &stale);

    assert_eq!(verdict.regime, Regime::Undetermined);
    assert_eq!(verdict.action, Action::None);
}

#[test]
fn a_stale_block_holds() {
    let stale = seen_at(10_000 - MAX_SOURCE_AGE_SECONDS - 1, 10_000);

    let verdict = decide(&params(), &input_at(10_000), &stale);

    assert_eq!(verdict.action, Action::None);
}

#[test]
fn two_stale_sources_that_agree_still_hold() {
    let stale = seen_at(1_000, 1_000);

    let verdict = decide(&params(), &input_at(10_000), &stale);

    assert_eq!(verdict.regime, Regime::Undetermined);
}

#[test]
fn a_time_from_the_future_holds() {
    let ahead = seen_at(10_000, 10_000 + MAX_SOURCE_AGE_SECONDS + 1);

    assert_eq!(
        decide(&params(), &input_at(10_000), &ahead).action,
        Action::None
    );
}

#[test]
fn an_absurd_time_holds() {
    for seen in [0, u64::MAX] {
        let verdict = decide(&params(), &input_at(10_000), &seen_at(10_000, seen));

        assert_eq!(verdict.action, Action::None, "{seen}");
    }
}

#[test]
fn the_oldest_allowed_source_passes() {
    let oldest = 10_000 - MAX_SOURCE_AGE_SECONDS;

    let verdict = decide(&params(), &input_at(10_000), &seen_at(oldest, oldest));

    assert_eq!(verdict.action, Action::SellRisk);
}

#[test]
fn a_market_that_cannot_be_read_records_a_silent_advisor() {
    let decision = respond(INPUT, Some(&secret_json()), |_, _| None).unwrap();

    assert_eq!(decision.obs.ai_flag, AI_SILENT);
    assert_eq!(decision.obs.pb, 0);
    assert_eq!(decision.regime, Regime::Undetermined);
    assert_eq!(decision.action, Action::None);
}

#[test]
fn a_run_without_a_secret_records_a_silent_advisor() {
    let decision = respond(INPUT, None, observed(431_000_000)).unwrap();

    assert_eq!(decision.obs.ai_flag, AI_SILENT);
}

#[test]
fn the_market_alone_cannot_trade_while_the_advisor_is_silent() {
    let reply = |call: &sources::Call| {
        Some(match &call.body {
            None => br#"{"error":[],"result":{"NEARUSD":[["3.9","100.0",1800000000.0,"b","l","",1]]}}"#.to_vec(),
            Some(body) if body.contains("\"block\"") => {
                json!({"result": {"header": {"height": 7, "timestamp": FIXTURE_NOW * 1_000_000_000_u64}}})
                    .to_string()
                    .into_bytes()
            }
            Some(_) => {
                // 39 USDC against 10 wNEAR: 3.9 USDC per wNEAR, below the sell threshold.
                let pool = json!({
                    "pool_kind": "SIMPLE_POOL",
                    "token_account_ids": ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "wrap.near"],
                    "amounts": ["39000000", "10000000000000000000000000"],
                });
                json!({"result": {"result": pool.to_string().as_bytes(), "block_height": 7}})
                    .to_string()
                    .into_bytes()
            }
        })
    };

    let decision = respond(INPUT, Some(&secret_json()), |_, _| {
        sources::observe_market(reply).map(Into::into)
    })
    .unwrap();

    assert_eq!(decision.obs.pa, LOW);
    assert_eq!(decision.obs.pb, LOW);
    assert_eq!(decision.action, Action::None);
}

#[test]
fn a_decision_with_market_prices_stays_under_the_target_size() {
    let market = Obs {
        pa: 439_164_602,
        pb: 438_770_000,
        ta: 1_793_541_593,
        tb: 1_793_541_547,
        ai_flag: AI_SILENT,
        ai_conf: 0,
    };
    let longest_vault = "v".repeat(MAX_ACCOUNT_BYTES);
    let input_data = INPUT.replace(
        r#""vault":"vault.owner.near""#,
        &format!(r#""vault":"{longest_vault}""#),
    );
    let secret = secret_json().replace(
        r#""wasm_hash":"bb""#,
        &format!(r#""wasm_hash":"{}""#, "b".repeat(HASH_HEX_BYTES)),
    );

    let reading = Observed {
        obs: market,
        ai_ref: AiRef {
            chat_id: "c".repeat(MAX_CHAT_ID_BYTES),
            resp_sig_hash: "d".repeat(HASH_HEX_BYTES),
        },
    };

    let decision = respond(&input_data, Some(&secret), |_, _| Some(reading)).unwrap();

    assert_eq!(decision.vault.len(), MAX_ACCOUNT_BYTES);
    assert_eq!(decision.wasm_hash.len(), HASH_HEX_BYTES);
    let size = serde_json::to_string(&decision).unwrap().len();
    assert!(size <= DECISION_TARGET_BYTES, "{size}");
}

#[test]
fn the_largest_decision_stays_under_the_target_size() {
    // A full-cap sell with every variable field at its longest: a 64-byte vault, hash and
    // chat id, ten-digit prices and a six-digit nonce.
    let price: u128 = 9_700_000_000;
    let cap = "4000000000000000000000000";
    let input_data = INPUT
        .replace(
            r#""vault":"vault.owner.near""#,
            &format!(r#""vault":"{}""#, "v".repeat(MAX_ACCOUNT_BYTES)),
        )
        .replace(r#""nonce":1"#, r#""nonce":123456"#)
        .replace(r#""wnear_book":"0""#, &format!(r#""wnear_book":"{cap}""#));
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["wasm_hash"] = json!("b".repeat(HASH_HEX_BYTES));
    secret["params"]["risk_on_above"] = json!("9900000000");
    secret["params"]["risk_off_below"] = json!("9800000000");
    secret["params"]["sell_wnear"] = json!(cap);
    let reading = Observed {
        obs: Obs {
            pa: price,
            pb: price,
            ta: FIXTURE_NOW,
            tb: FIXTURE_NOW,
            ai_flag: AI_CLEAR,
            ai_conf: 100,
        },
        ai_ref: AiRef {
            chat_id: "c".repeat(MAX_CHAT_ID_BYTES),
            resp_sig_hash: "d".repeat(HASH_HEX_BYTES),
        },
    };

    let decision = respond(&input_data, Some(&secret.to_string()), |_, _| Some(reading)).unwrap();

    assert_eq!(decision.action, Action::SellRisk);
    assert_eq!(decision.amount_in.to_string().len(), cap.len());
    let size = serde_json::to_string(&decision).unwrap().len();
    assert!(size <= DECISION_TARGET_BYTES, "{size}");
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
fn the_shared_fixture_matches_this_crate() {
    // The vault's `reveal` tests open the same commitment.
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/commitment.json")).unwrap();
    let text = |field: &str| fixture[field].as_str().unwrap().to_string();

    assert_eq!(params().canonical(), text("params"));
    assert_eq!(text("salt"), salt_hex());
    let value = commitment(
        &text("chain"),
        &text("vault"),
        &text("wasm_hash"),
        &params(),
        &salt(),
    );
    assert_eq!(value, text("commitment"));
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
    let expected = inputs_digest(INPUT, &fresh_obs(431_000_000), "");
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
    assert_eq!(wire["obs"]["ta"], FIXTURE_NOW);
}

#[test]
fn the_reference_of_a_reading_reaches_the_decision() {
    let reading = Observed {
        obs: fresh_obs(431_000_000),
        ai_ref: AiRef {
            chat_id: "chat".into(),
            resp_sig_hash: "abc".into(),
        },
    };
    let expected = inputs_digest(INPUT, &reading.obs, "abc");

    let decision = respond(INPUT, Some(&secret_json()), |_, _| Some(reading)).unwrap();

    assert_eq!(decision.ai_ref.chat_id, "chat");
    assert_eq!(decision.inputs_digest, expected);
}

#[test]
fn the_key_stays_out_of_the_decision() {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["ai_key"] = json!("the-key");

    let decision = respond(INPUT, Some(&secret.to_string()), observed(431_000_000)).unwrap();

    assert!(!serde_json::to_string(&decision)
        .unwrap()
        .contains("the-key"));
}

fn secret_with_key(key: &str) -> String {
    let mut secret: serde_json::Value = serde_json::from_str(&secret_json()).unwrap();
    secret["ai_key"] = json!(key);
    secret.to_string()
}

fn answers_with_secret(secret: &str) -> bool {
    let decision = respond(INPUT, Some(secret), observed(431_000_000)).unwrap();
    decision.commitment == KNOWN_COMMITMENT
}

/// A prompt whose published params come to exactly `size` bytes.
fn prompt_for_params_of(size: usize) -> String {
    let empty = Params {
        prompt: String::new(),
        ..params()
    };
    "p".repeat(size - empty.canonical().len())
}

#[test]
fn a_secret_without_a_key_still_answers() {
    let decision = respond(INPUT, Some(&secret_json()), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, KNOWN_COMMITMENT);
}

#[test]
fn a_well_formed_key_is_accepted() {
    assert!(answers_with_secret(&secret_with_key("sk-Abc_123.xyz")));
}

#[test]
fn a_key_that_cannot_be_sent_is_refused() {
    for key in ["", "sk-abc\n", "sk-abc\r\n", "sk abc", "sk-ä"] {
        assert!(!answers_with_secret(&secret_with_key(key)), "{key:?}");
    }
}

#[test]
fn a_key_too_long_for_a_header_is_refused() {
    assert!(!answers_with_secret(&secret_with_key(
        &"k".repeat(MAX_KEY_BYTES + 1)
    )));
}

#[test]
fn a_prompt_is_required() {
    refuses_param("prompt", "");
}

#[test]
fn the_reveal_limit_is_the_vaults() {
    let vault = include_str!("../../contracts/vault/src/reveal.rs");

    assert!(vault.contains("pub const MAX_PARAMS_BYTES: usize = 8 * 1024;"));
    assert_eq!(MAX_PARAMS_BYTES, 8 * 1024);
}

#[test]
fn params_that_fill_the_reveal_limit_pass() {
    let secret = secret_with_param("prompt", &prompt_for_params_of(MAX_PARAMS_BYTES));

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_ne!(decision.commitment, "");
}

#[test]
fn params_past_the_reveal_limit_are_refused() {
    refuses_param("prompt", &prompt_for_params_of(MAX_PARAMS_BYTES + 1));
}

#[test]
fn the_reveal_limit_counts_escaped_bytes() {
    // Each newline is published as two bytes.
    refuses_param("prompt", &"\n".repeat(MAX_PARAMS_BYTES / 2));
}

#[test]
fn newlines_and_tabs_are_allowed_in_a_prompt() {
    let secret = secret_with_param("prompt", "Line one.\n\tLine two.");

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_ne!(decision.commitment, "");
}

#[test]
fn a_prompt_outside_printable_ascii_is_refused() {
    // Python's json.dumps escapes these where serde_json does not, so a sealing script
    // and the WASM would commit to different bytes.
    for prompt in [
        "Don\u{2019}t buy",
        "caf\u{e9}",
        "a\u{7f}b",
        "a\u{1}b",
        "a\rb",
    ] {
        refuses_param("prompt", prompt);
    }
}

#[test]
fn a_prompt_with_quotes_stays_canonical_json() {
    let quoted = Params {
        prompt: "Say \"yes\".\nThen stop.".into(),
        ..params()
    };

    let text = quoted.canonical();

    let parsed: Params = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed, quoted);
}

#[test]
fn a_decision_fits_the_target_size() {
    let long_vault = format!("{}.fdl-m3-738321.testnet", "v".repeat(20));
    let input = INPUT.replace(VAULT, &long_vault);
    let hash = "a".repeat(64);
    let secret = secret_json().replace("\"bb\"", &format!("\"{hash}\""));

    let decision = respond(&input, Some(&secret), observed(431_000_000)).unwrap();

    assert!(serde_json::to_vec(&decision).unwrap().len() <= DECISION_TARGET_BYTES);
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
fn a_salt_with_sign_characters_is_no_secret() {
    let secret = secret_json().replace(&salt_hex(), &"+0".repeat(32));

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
}

#[test]
fn a_salt_that_is_not_hex_is_no_secret() {
    let secret = secret_json().replace(&salt_hex(), &"zz".repeat(32));

    let decision = respond(INPUT, Some(&secret), observed(431_000_000)).unwrap();

    assert_eq!(decision.commitment, "");
}

#[test]
fn no_observation_holds_but_still_proves_the_secret() {
    let decision = respond(INPUT, Some(&secret_json()), |_, _| None).unwrap();

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

    assert_eq!(respond(&input, None, |_, _| None), Err(BadInput));
}

#[test]
fn broken_input_is_refused() {
    assert_eq!(respond("not json", None, |_, _| None), Err(BadInput));
}
