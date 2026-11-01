//! The two public prices, read out of their raw replies. `observe_market` takes the network
//! as an argument, so every rule here runs on the host; `main.rs` owns the socket.
//!
//! The sources are the mainnet market whichever chain the vault runs on, because a testnet
//! pool carries no market price.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{Obs, AI_SILENT};

const TRADE_HOST: &str = "api.kraken.com";
/// Several trades, so one small print at an odd price cannot set `pb`.
const TRADE_PATH: &str = "/0/public/Trades?pair=NEARUSD&count=20";
const TRADE_PAIR: &str = "NEARUSD";
const RPC_HOST: &str = "free.rpc.fastnear.com";
const RPC_PATH: &str = "/";
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
    pub host: &'static str,
    pub path: &'static str,
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
    block_height: u64,
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
    let pa = pool_spot(&send(&pool_call(height))?, height)?;
    let (pb, tb) = read_trades(&send(&trades_call())?)?;
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
        host: RPC_HOST,
        path: RPC_PATH,
        body: Some(body.to_string()),
    }
}

fn block_call() -> Call {
    rpc_call("block", json!({ "finality": "final" }))
}

/// Pinned to a height, and `pool_spot` checks the reply, so `ta` is the time of this price.
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

fn trades_call() -> Call {
    Call {
        host: TRADE_HOST,
        path: TRADE_PATH,
        body: None,
    }
}

pub fn read_block(reply: &[u8]) -> Option<(u64, u64)> {
    let reply: BlockReply = serde_json::from_slice(reply).ok()?;
    let header = reply.result.header;
    Some((header.height, header.timestamp / NANOS_PER_SECOND))
}

/// USDC per wNEAR with eight decimals, the unit of the vault's reference price.
pub fn pool_spot(reply: &[u8], height: u64) -> Option<u128> {
    let reply: ViewReply = serde_json::from_slice(reply).ok()?;
    if reply.result.block_height != height {
        return None;
    }
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

/// The price weighted by volume, and the time of the newest trade. The rows run oldest to
/// newest; each is `[price, volume, time, ...]`.
pub fn read_trades(reply: &[u8]) -> Option<(u128, u64)> {
    let reply: Value = serde_json::from_slice(reply).ok()?;
    if !reply["error"].as_array()?.is_empty() {
        return None;
    }
    let rows = reply["result"][TRADE_PAIR].as_array()?;
    let (mut value, mut volume) = (0_u128, 0_u128);
    for row in rows {
        let price = parse_decimal(row[0].as_str()?)?;
        let size = parse_decimal(row[1].as_str()?)?;
        value = value.checked_add(price.checked_mul(size)?)?;
        volume = volume.checked_add(size)?;
    }
    let seconds = rows.last()?[2].as_f64()? as u64;
    Some((value.checked_div(volume)?, seconds))
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// A decimal text to eight decimals. Digits past the eighth are dropped.
pub fn parse_decimal(text: &str) -> Option<u128> {
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
