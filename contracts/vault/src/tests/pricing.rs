use near_sdk::serde_json::{self, json};

use crate::pricing::{read_anchor, Anchor, PriceLimits, PriceReject};

const NEAR_ID: &str = "near-id";
const USDC_ID: &str = "usdc-id";
const NOW: u64 = 1_800_000_000;
const SCALE: u128 = 1_000_000_000_000_000_000;
const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;
const USDC: u128 = 1_000_000;

fn limits() -> PriceLimits<'static> {
    PriceLimits {
        near_id: NEAR_ID,
        usdc_id: USDC_ID,
        now: NOW,
        max_age: 120,
        max_conf_bps: 50,
    }
}

fn feed(price: &str) -> serde_json::Value {
    json!({ "price": price, "conf": "10000", "expo": -8, "publish_time": NOW - 30 })
}

fn body() -> serde_json::Value {
    json!({ NEAR_ID: feed("450000000"), USDC_ID: feed("100000000") })
}

fn read(value: &serde_json::Value) -> Result<Anchor, PriceReject> {
    read_anchor(value.to_string().as_bytes(), &limits())
}

fn anchor() -> Anchor {
    read(&body()).unwrap()
}

#[test]
fn two_fresh_feeds_give_an_anchor() {
    let anchor = anchor();

    assert_eq!(anchor.near, 450_000_000);
    assert_eq!(anchor.usdc, 100_000_000);
}

#[test]
fn a_real_oracle_reply_parses() {
    // One raw reply of aggregate-oracle.near, read from mainnet on 2026-11-01.
    let raw = br#"{"eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a":{"price":"99981104","conf":"102229","expo":-8,"publish_time":1793525925},"c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750":{"price":"437673488","conf":"171059","expo":-8,"publish_time":1793525925}}"#;
    let limits = PriceLimits {
        near_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750",
        usdc_id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
        now: 1_793_525_955,
        max_age: 120,
        max_conf_bps: 50,
    };

    let anchor = read_anchor(raw, &limits).unwrap();

    assert_eq!(anchor.near, 437_673_488);
    assert_eq!(anchor.usdc, 99_981_104);
}

#[test]
fn a_null_feed_is_unavailable() {
    let mut value = body();
    value[NEAR_ID] = json!(null);

    assert_eq!(read(&value), Err(PriceReject::Unavailable));
}

#[test]
fn a_missing_feed_is_unavailable() {
    let value = json!({ NEAR_ID: feed("450000000") });

    assert_eq!(read(&value), Err(PriceReject::Unavailable));
}

#[test]
fn garbage_is_unavailable() {
    assert_eq!(
        read_anchor(b"not json", &limits()),
        Err(PriceReject::Unavailable)
    );
}

#[test]
fn a_zero_price_is_unavailable() {
    let mut value = body();
    value[USDC_ID] = feed("0");

    assert_eq!(read(&value), Err(PriceReject::Unavailable));
}

#[test]
fn different_exponents_are_unavailable() {
    let mut value = body();
    value[USDC_ID]["expo"] = json!(-6);

    assert_eq!(read(&value), Err(PriceReject::Unavailable));
}

#[test]
fn an_old_publish_time_is_stale() {
    let mut value = body();
    value[NEAR_ID]["publish_time"] = json!(NOW - 121);

    assert_eq!(read(&value), Err(PriceReject::Stale));
}

#[test]
fn the_oldest_allowed_publish_time_passes() {
    let mut value = body();
    value[NEAR_ID]["publish_time"] = json!(NOW - 120);

    assert!(read(&value).is_ok());
}

#[test]
fn a_publish_time_from_the_future_is_stale() {
    let mut value = body();
    value[USDC_ID]["publish_time"] = json!(NOW + 6);

    assert_eq!(read(&value), Err(PriceReject::Stale));
}

#[test]
fn a_small_clock_lead_passes() {
    let mut value = body();
    value[USDC_ID]["publish_time"] = json!(NOW + 5);

    assert!(read(&value).is_ok());
}

#[test]
fn a_wide_confidence_is_refused() {
    let mut value = body();
    value[NEAR_ID]["conf"] = json!("2250001");

    assert_eq!(read(&value), Err(PriceReject::Wide));
}

#[test]
fn the_widest_allowed_confidence_passes() {
    let mut value = body();
    value[NEAR_ID]["conf"] = json!("2250000");

    assert!(read(&value).is_ok());
}

#[test]
fn a_huge_confidence_is_wide_without_a_panic() {
    let mut value = body();
    value[NEAR_ID]["conf"] = json!(u128::MAX.to_string());

    assert_eq!(read(&value), Err(PriceReject::Wide));
}

#[test]
fn a_huge_price_is_unavailable_without_a_panic() {
    let mut value = body();
    value[NEAR_ID]["price"] = json!(u128::MAX.to_string());

    assert_eq!(read(&value), Err(PriceReject::Unavailable));
}

#[test]
fn the_highest_valid_price_gives_a_reference_price() {
    let mut value = body();
    value[NEAR_ID]["price"] = json!(i64::MAX.to_string());
    value[USDC_ID]["price"] = json!("1");
    value[USDC_ID]["conf"] = json!("0");

    let expected = i64::MAX as u128 * 100_000_000;
    assert_eq!(read(&value).unwrap().ref_price(), expected);
}

#[test]
fn a_huge_publish_time_is_stale_without_a_panic() {
    let mut value = body();
    value[NEAR_ID]["publish_time"] = json!(u64::MAX);

    assert_eq!(read(&value), Err(PriceReject::Stale));
}

#[test]
fn the_reference_price_is_wnear_in_usdc() {
    assert_eq!(anchor().ref_price(), 450_000_000);
}

#[test]
fn a_reference_price_inside_the_band_passes() {
    assert!(anchor().accepts_ref_price(459_000_000, 200));
    assert!(anchor().accepts_ref_price(441_000_000, 200));
}

#[test]
fn a_reference_price_outside_the_band_is_refused() {
    assert!(!anchor().accepts_ref_price(459_000_001, 200));
    assert!(!anchor().accepts_ref_price(440_999_999, 200));
}

#[test]
fn a_huge_reference_price_is_outside_the_band() {
    assert!(!anchor().accepts_ref_price(u128::MAX, 200));
}

#[test]
fn wnear_is_valued_in_usdc() {
    assert_eq!(anchor().wnear_value(2 * WNEAR, SCALE), 9 * USDC);
}

#[test]
fn a_buy_gets_a_minimum_in_wnear() {
    let expected = (USDC * SCALE * 100_000_000 * 9_850).div_ceil(450_000_000 * 10_000);

    assert_eq!(anchor().min_out_buy(USDC, 150, SCALE), expected);
}

#[test]
fn a_sell_gets_a_minimum_in_usdc() {
    assert_eq!(anchor().min_out_sell(WNEAR, 150, SCALE), 4_432_500);
}

#[test]
fn the_minimum_rounds_up() {
    assert_eq!(anchor().min_out_sell(1, 150, SCALE), 1);
}

#[test]
fn a_usdc_depeg_lowers_the_minimum_of_a_buy() {
    let mut value = body();
    value[USDC_ID] = feed("90000000");
    let depegged = read(&value).unwrap();

    assert!(depegged.min_out_buy(USDC, 150, SCALE) < anchor().min_out_buy(USDC, 150, SCALE));
}
