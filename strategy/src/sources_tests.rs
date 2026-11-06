use serde_json::json;

use super::sources::{
    call_deadline, observe_market, parse_decimal, pool_spot, read_block, read_trades, Call,
    CALL_BUDGET_NANOS,
};
use super::AI_SILENT;

// Raw replies, read on 2026-11-01. The trades were asked with `count=3` to stay short.
const TRADES: &[u8] = br#"{"error":[],"result":{"NEARUSD":[["4.37780","67.00000000",1793543565.4516315,"b","l","",5877989],["4.37780","127.71266986",1793543565.4516315,"b","l","",5877990],["4.37790","305.28733014",1793543565.4516315,"b","l","",5877991]],"last":"1793543565451631496"}}"#;
const POOL: &str = r#"{"pool_kind":"SIMPLE_POOL","token_account_ids":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","wrap.near"],"amounts":["1053151412531","239807900351508781854310773855"],"total_fee":30,"shares_total_supply":"93730843345258110775473380964","amp":0}"#;
const HEIGHT: u64 = 222_578_796;
const BLOCK_NANOS: u64 = 1_793_541_593_157_973_801;
const BLOCK_SECONDS: u64 = 1_793_541_593;
// 1053151412531 · 10^8 / 239807900351, computed with Python.
const SPOT: u128 = 439_164_602;
// Weighted by volume, computed with Python.
const TRADE_PRICE: u128 = 437_786_105;
const TRADE_SECONDS: u64 = 1_793_543_565;
const POOL_ARGS: &str = "eyJwb29sX2lkIjo0NTEyfQ==";

fn block_reply() -> Vec<u8> {
    json!({"jsonrpc": "2.0", "id": "f", "result": {"header": {"height": HEIGHT, "timestamp": BLOCK_NANOS}}})
        .to_string()
        .into_bytes()
}

fn pool_reply(pool: &str) -> Vec<u8> {
    json!({"jsonrpc": "2.0", "id": "f", "result": {"result": pool.as_bytes(), "logs": [], "block_height": HEIGHT, "block_hash": "h"}})
        .to_string()
        .into_bytes()
}

fn spot_of(pool: &str) -> Option<u128> {
    pool_spot(&pool_reply(pool), HEIGHT)
}

fn pool_with(field: &str, value: serde_json::Value) -> String {
    let mut pool: serde_json::Value = serde_json::from_str(POOL).unwrap();
    pool[field] = value;
    pool.to_string()
}

fn trades_of(rows: &str) -> Option<(u128, u64)> {
    let reply = format!(r#"{{"error":[],"result":{{"NEARUSD":{rows}}}}}"#);
    read_trades(reply.as_bytes())
}

/// Answers every call, except the one that `broken` names.
fn network(broken: Option<&'static str>) -> impl FnMut(&Call) -> Option<Vec<u8>> {
    move |call| {
        let name = match &call.body {
            None => "trade",
            Some(body) if body.contains("\"block\"") => "block",
            Some(_) => "pool",
        };
        if broken == Some(name) {
            return None;
        }
        Some(match name {
            "trade" => TRADES.to_vec(),
            "block" => block_reply(),
            _ => pool_reply(POOL),
        })
    }
}

#[test]
fn a_real_trade_reply_gives_the_weighted_price_and_the_newest_time() {
    assert_eq!(read_trades(TRADES), Some((TRADE_PRICE, TRADE_SECONDS)));
}

#[test]
fn a_small_print_at_an_odd_price_barely_moves_the_price() {
    let rows = r#"[["4.00","1000.0",100.0,"b","l","",1],["5.00","0.1",200.0,"b","l","",2]]"#;

    let (price, _) = trades_of(rows).unwrap();

    assert_eq!(price, 400_009_999);
}

#[test]
fn the_newest_time_is_the_last_row() {
    let rows = r#"[["4.1","1",100.0,"b","l","",1],["4.1","1",200.0,"b","l","",2]]"#;

    assert_eq!(trades_of(rows), Some((410_000_000, 200)));
}

#[test]
fn a_trade_reply_with_an_error_is_refused() {
    let reply = r#"{"error":["EQuery:Unknown asset pair"],"result":{"NEARUSD":[["4.3","1",1793541547.5,"b","l","",1]]}}"#;

    assert_eq!(read_trades(reply.as_bytes()), None);
}

#[test]
fn a_trade_reply_without_rows_is_refused() {
    assert_eq!(trades_of("[]"), None);
}

#[test]
fn a_trade_reply_of_another_pair_is_refused() {
    let reply = r#"{"error":[],"result":{"XBTUSD":[["4.3","1",1793541547.5,"b","l","",1]]}}"#;

    assert_eq!(read_trades(reply.as_bytes()), None);
}

#[test]
fn a_trade_price_that_is_not_text_is_refused() {
    assert_eq!(trades_of(r#"[[4.3,"1",100.0,"b","l","",1]]"#), None);
}

#[test]
fn a_trade_volume_that_is_not_text_is_refused() {
    assert_eq!(trades_of(r#"[["4.3",1,100.0,"b","l","",1]]"#), None);
}

#[test]
fn a_trade_time_that_is_not_a_number_is_refused() {
    assert_eq!(trades_of(r#"[["4.3","1","soon","b","l","",1]]"#), None);
}

#[test]
fn one_broken_row_refuses_the_whole_reply() {
    let rows = r#"[["4.1","1",100.0,"b","l","",1],["broken","1",200.0,"b","l","",2]]"#;

    assert_eq!(trades_of(rows), None);
}

#[test]
fn trades_without_volume_are_refused() {
    assert_eq!(trades_of(r#"[["4.1","0",100.0,"b","l","",1]]"#), None);
}

#[test]
fn a_volume_too_big_for_the_arithmetic_is_refused() {
    let rows = format!(
        r#"[["4.1","{}",100.0,"b","l","",1]]"#,
        u128::MAX / 100_000_000
    );

    assert_eq!(trades_of(&rows), None);
}

#[test]
fn a_time_outside_the_type_saturates_and_is_left_to_the_age_rule() {
    assert_eq!(
        trades_of(r#"[["4.1","1",-5.0,"b","l","",1]]"#),
        Some((410_000_000, 0))
    );
    assert_eq!(
        trades_of(r#"[["4.1","1",1e30,"b","l","",1]]"#),
        Some((410_000_000, u64::MAX))
    );
}

#[test]
fn garbage_is_not_a_trade() {
    assert_eq!(read_trades(b"<html>blocked</html>"), None);
}

#[test]
fn prices_scale_to_eight_decimals() {
    assert_eq!(parse_decimal("4.38770"), Some(438_770_000));
    assert_eq!(parse_decimal("4"), Some(400_000_000));
    assert_eq!(parse_decimal("0.00000001"), Some(1));
}

#[test]
fn digits_past_eight_decimals_are_dropped() {
    assert_eq!(parse_decimal("4.123456789"), Some(412_345_678));
}

#[test]
fn malformed_prices_are_refused() {
    for text in [
        "", ".5", "4.", "-1", "+1", "1e3", "4,3", "4.3.1", " 4.3", "NaN",
    ] {
        assert_eq!(parse_decimal(text), None, "{text}");
    }
}

#[test]
fn a_price_too_big_for_the_type_is_refused() {
    assert_eq!(parse_decimal(&"9".repeat(40)), None);
}

#[test]
fn a_real_pool_reply_gives_the_spot_price() {
    assert_eq!(spot_of(POOL), Some(SPOT));
}

#[test]
fn a_pool_of_other_tokens_is_refused() {
    let pool = pool_with(
        "token_account_ids",
        json!(["usdt.tether-token.near", "wrap.near"]),
    );

    assert_eq!(spot_of(&pool), None);
}

#[test]
fn a_pool_with_the_tokens_swapped_is_refused() {
    let usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let pool = pool_with("token_account_ids", json!(["wrap.near", usdc]));

    assert_eq!(spot_of(&pool), None);
}

#[test]
fn a_pool_of_another_kind_is_refused() {
    assert_eq!(spot_of(&pool_with("pool_kind", json!("STABLE_SWAP"))), None);
}

#[test]
fn a_pool_with_one_amount_is_refused() {
    assert_eq!(spot_of(&pool_with("amounts", json!(["1"]))), None);
}

#[test]
fn a_pool_without_wnear_is_refused() {
    assert_eq!(
        spot_of(&pool_with("amounts", json!(["1000000", "0"]))),
        None
    );
}

#[test]
fn a_pool_too_big_for_the_arithmetic_is_refused() {
    let amounts = json!([u128::MAX.to_string(), "239807900351508781854310773855"]);

    assert_eq!(spot_of(&pool_with("amounts", amounts)), None);
}

#[test]
fn a_view_that_failed_is_refused() {
    let reply = json!({"jsonrpc": "2.0", "id": "f", "result": {"error": "wasm trap", "logs": [], "block_height": HEIGHT, "block_hash": "h"}});

    assert_eq!(pool_spot(reply.to_string().as_bytes(), HEIGHT), None);
}

#[test]
fn a_pool_read_at_another_height_is_refused() {
    assert_eq!(pool_spot(&pool_reply(POOL), HEIGHT + 1), None);
}

#[test]
fn an_rpc_error_is_refused() {
    let reply = json!({"jsonrpc": "2.0", "id": "f", "error": {"code": -32000, "message": "busy"}});

    assert_eq!(pool_spot(reply.to_string().as_bytes(), HEIGHT), None);
    assert_eq!(read_block(reply.to_string().as_bytes()), None);
}

#[test]
fn a_block_reply_gives_its_height_and_seconds() {
    assert_eq!(read_block(&block_reply()), Some((HEIGHT, BLOCK_SECONDS)));
}

#[test]
fn the_market_is_read_from_all_three_replies() {
    let obs = observe_market(network(None)).unwrap();

    assert_eq!(obs.pa, SPOT);
    assert_eq!(obs.ta, BLOCK_SECONDS);
    assert_eq!(obs.pb, TRADE_PRICE);
    assert_eq!(obs.tb, TRADE_SECONDS);
}

#[test]
fn the_advisor_stays_silent_until_it_is_wired_in() {
    let obs = observe_market(network(None)).unwrap();

    assert_eq!(obs.ai_flag, AI_SILENT);
    assert_eq!(obs.ai_conf, 0);
}

#[test]
fn the_pool_is_read_at_the_block_that_gave_the_time() {
    let mut bodies = Vec::new();
    let mut inner = network(None);
    observe_market(|call: &Call| {
        bodies.extend(call.body.clone());
        inner(call)
    })
    .unwrap();

    let query: serde_json::Value = serde_json::from_str(&bodies[1]).unwrap();
    assert_eq!(query["params"]["block_id"], HEIGHT);
    assert_eq!(query["params"]["args_base64"], POOL_ARGS);
    assert_eq!(query["params"]["account_id"], "v2.ref-finance.near");
    assert_eq!(query["params"]["method_name"], "get_pool");
    assert!(query["params"].get("finality").is_none());
}

#[test]
fn any_source_that_fails_ends_the_reading() {
    for name in ["trade", "block", "pool"] {
        assert_eq!(observe_market(network(Some(name))), None, "{name}");
    }
}

#[test]
fn a_call_gets_its_own_slice_of_the_run() {
    let run_deadline = 30_000_000_000;

    assert_eq!(call_deadline(0, run_deadline), CALL_BUDGET_NANOS);
}

#[test]
fn a_call_never_outlives_the_run() {
    let run_deadline = 30_000_000_000;

    assert_eq!(call_deadline(run_deadline - 1, run_deadline), run_deadline);
}

#[test]
fn a_stalled_first_call_leaves_time_for_the_next() {
    let run_deadline = 30_000_000_000;
    let after_first = call_deadline(0, run_deadline);

    assert!(call_deadline(after_first, run_deadline) > after_first);
}
