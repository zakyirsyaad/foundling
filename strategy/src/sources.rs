//! The two public prices, read out of their raw replies. `observe_market` takes the network
//! as an argument, so every rule here runs on the host; `main.rs` owns the socket.
//!
//! The sources are the mainnet market whichever chain the vault runs on, because a testnet
//! pool carries no market price.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{Obs, AI_SILENT};

const TRADE_URL: &str = "https://api.kraken.com/0/public/Trades?pair=NEARUSD&count=1";
const TRADE_PAIR: &str = "NEARUSD";
const RPC_URL: &str = "https://free.rpc.fastnear.com";
const REF: &str = "v2.ref-finance.near";
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR: &str = "wrap.near";
const POOL_KIND: &str = "SIMPLE_POOL";
/// `{"pool_id":4512}`, the pool the vault trades.
const POOL_ARGS: &str = "eyJwb29sX2lkIjo0NTEyfQ==";
const PRICE_DECIMALS: usize = 8;
const PRICE_ONE: u128 = 100_000_000;
/// wNEAR has 24 decimals and USDC 6.
const WNEAR_UNITS_PER_USDC_UNIT: u128 = 1_000_000_000_000_000_000;
const NANOS_PER_SECOND: u64 = 1_000_000_000;

pub struct Call {
    pub url: &'static str,
    pub body: Option<String>,
}

#[derive(Deserialize)]
struct BlockReply {
    result: BlockResult,
}

#[derive(Deserialize)]
struct BlockResult {
    header: Header,
}

#[derive(Deserialize)]
struct Header {
    height: u64,
    timestamp: u64,
}

#[derive(Deserialize)]
struct ViewReply {
    result: ViewResult,
}

#[derive(Deserialize)]
struct ViewResult {
    result: Vec<u8>,
}

#[derive(Deserialize)]
struct Pool {
    pool_kind: String,
    token_account_ids: Vec<String>,
    amounts: Vec<String>,
}

/// A source that fails ends the reading, and the strategy holds. The advisor is not wired
/// in yet, so this reading can record prices but cannot trade.
pub fn observe_market(mut send: impl FnMut(&Call) -> Option<Vec<u8>>) -> Option<Obs> {
    let (height, ta) = read_block(&send(&block_call())?)?;
    let pa = pool_spot(&send(&pool_call(height))?)?;
    let (pb, tb) = read_trade(&send(&trade_call())?)?;
    Some(Obs {
        pa,
        pb,
        ta,
        tb,
        ai_flag: AI_SILENT,
        ai_conf: 0,
    })
}

fn rpc_call(method: &str, params: Value) -> Call {
    let body = json!({ "jsonrpc": "2.0", "id": "foundling", "method": method, "params": params });
    Call {
        url: RPC_URL,
        body: Some(body.to_string()),
    }
}

fn block_call() -> Call {
    rpc_call("block", json!({ "finality": "final" }))
}

/// Pinned to a height, so `ta` is the time of this very price.
fn pool_call(height: u64) -> Call {
    rpc_call(
        "query",
        json!({
            "request_type": "call_function",
            "block_id": height,
            "account_id": REF,
            "method_name": "get_pool",
            "args_base64": POOL_ARGS,
        }),
    )
}

fn trade_call() -> Call {
    Call {
        url: TRADE_URL,
        body: None,
    }
}

pub fn read_block(reply: &[u8]) -> Option<(u64, u64)> {
    let reply: BlockReply = serde_json::from_slice(reply).ok()?;
    let header = reply.result.header;
    Some((header.height, header.timestamp / NANOS_PER_SECOND))
}

/// USDC per wNEAR with eight decimals, the unit of the vault's reference price.
pub fn pool_spot(reply: &[u8]) -> Option<u128> {
    let reply: ViewReply = serde_json::from_slice(reply).ok()?;
    let pool: Pool = serde_json::from_slice(&reply.result.result).ok()?;
    if pool.pool_kind != POOL_KIND || pool.token_account_ids != [USDC, WNEAR] {
        return None;
    }
    let [usdc, wnear] = pool.amounts.as_slice() else {
        return None;
    };
    let usdc: u128 = usdc.parse().ok()?;
    let wnear: u128 = wnear.parse().ok()?;
    usdc.checked_mul(PRICE_ONE)?
        .checked_div(wnear / WNEAR_UNITS_PER_USDC_UNIT)
}

/// The rows run oldest to newest; each is `[price, volume, time, ...]`.
pub fn read_trade(reply: &[u8]) -> Option<(u128, u64)> {
    let reply: Value = serde_json::from_slice(reply).ok()?;
    if !reply["error"].as_array()?.is_empty() {
        return None;
    }
    let row = reply["result"][TRADE_PAIR].as_array()?.last()?;
    let price = parse_price(row[0].as_str()?)?;
    let seconds = row[2].as_f64()? as u64;
    Some((price, seconds))
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// A decimal text to eight decimals. Digits past the eighth are dropped.
pub fn parse_price(text: &str) -> Option<u128> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, "0"));
    if !is_digits(whole) || !is_digits(fraction) {
        return None;
    }
    let kept = &fraction[..fraction.len().min(PRICE_DECIMALS)];
    let fraction: u128 = format!("{kept:0<PRICE_DECIMALS$}").parse().ok()?;
    whole
        .parse::<u128>()
        .ok()?
        .checked_mul(PRICE_ONE)?
        .checked_add(fraction)
}
