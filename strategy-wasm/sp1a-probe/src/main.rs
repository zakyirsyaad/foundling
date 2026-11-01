use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};
use wasi_http_client::Client;

const BUILD_ID: &str = match option_env!("SP1A_BUILD_ID") {
    Some(id) => id,
    None => "dev",
};
const SECRET_VAR: &str = "SP1A_PROBE_SECRET";
const NEAR_AI_KEY_VAR: &str = "NEAR_AI_API_KEY";
const NEAR_AI_URL: &str = "https://cloud-api.near.ai/v1/chat/completions";
const NEAR_AI_MODEL_DEFAULT: &str = "Qwen/Qwen3.6-35B-A3B-FP8";

#[derive(Deserialize)]
#[serde(default)]
struct Input {
    mode: String,
    sleep_s: u64,
    model: String,
    rpc_url: String,
    pool_id: u64,
    usdc_id: String,
    wnear_id: String,
    cex_url: String,
    http_get_url: String,
}

impl Default for Input {
    fn default() -> Self {
        Input {
            mode: "normal".into(),
            sleep_s: 0,
            model: NEAR_AI_MODEL_DEFAULT.into(),
            rpc_url: "https://rpc.mainnet.near.org".into(),
            pool_id: 4512,
            usdc_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1".into(),
            wnear_id: "wrap.near".into(),
            cex_url: "https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT".into(),
            http_get_url: "https://api.coinbase.com/v2/time".into(),
        }
    }
}

type Failure = Box<dyn std::error::Error>;

fn main() {
    let started = Instant::now();
    let mut raw = String::new();
    let _ = io::stdin().read_to_string(&mut raw);
    let input: Input = if raw.trim().is_empty() {
        Input::default()
    } else {
        match serde_json::from_str(&raw) {
            Ok(input) => input,
            Err(_) => {
                println!("{}", json!({"v": 1, "build": BUILD_ID, "err": "bad_input"}));
                return;
            }
        }
    };

    if input.mode == "fail" {
        eprintln!("sp1a: deliberate failure");
        std::process::exit(1);
    }

    let mut out = json!({"v": 1, "build": BUILD_ID, "mode": input.mode});

    match input.mode.as_str() {
        "sleep" => {
            std::thread::sleep(Duration::from_secs(input.sleep_s));
            out["slept_s"] = json!(input.sleep_s);
        }
        "big" => {
            out["pad"] = json!("x".repeat(1200));
        }
        _ => {
            out["http_get"] = probe(|| http_get_status(&input.http_get_url));
            out["secret"] = probe(secret_info);
            out["nearai"] = probe(|| nearai_reply(&input.model));
            out["cex"] = probe(|| cex_price(&input.cex_url));
            out["rhea"] = probe(|| rhea_spot(&input));
        }
    }

    out["ms"] = json!(started.elapsed().as_millis() as u64);
    let mut stdout = io::stdout();
    let _ = writeln!(stdout, "{}", out);
    let _ = stdout.flush();
}

fn probe(step: impl FnOnce() -> Result<Value, Failure>) -> Value {
    step().unwrap_or_else(|e| {
        let msg: String = e.to_string().chars().take(120).collect();
        json!({"err": msg})
    })
}

fn http_get_status(url: &str) -> Result<Value, Failure> {
    let resp = Client::new()
        .get(url)
        .connect_timeout(Duration::from_secs(20))
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.body().map_err(|e| e.to_string())?;
    Ok(json!({"status": status, "bytes": body.len()}))
}

fn secret_info() -> Result<Value, Failure> {
    Ok(json!({"present": env::var(SECRET_VAR).is_ok()}))
}

fn nearai_reply(model: &str) -> Result<Value, Failure> {
    let key = match env::var(NEAR_AI_KEY_VAR) {
        Ok(key) if !key.is_empty() => key,
        _ => return Ok(json!({"present": false})),
    };
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word OK."}],
        "max_tokens": 8,
        "temperature": 0,
        "stream": false
    });
    let resp = Client::new()
        .post(NEAR_AI_URL)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {key}"))
        .header("x-no-aliasing", "true")
        .connect_timeout(Duration::from_secs(30))
        .body(body.to_string().as_bytes())
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.body().map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(&bytes)?;
    let reply: String = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(80)
        .collect();
    Ok(json!({"status": status, "model": parsed["model"], "reply": reply}))
}

fn cex_price(url: &str) -> Result<Value, Failure> {
    let resp = Client::new()
        .get(url)
        .connect_timeout(Duration::from_secs(20))
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.body().map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(&bytes)?;
    Ok(json!({"status": status, "symbol": parsed["symbol"], "price": parsed["price"]}))
}

fn rhea_spot(input: &Input) -> Result<Value, Failure> {
    let args = json!({"pool_id": input.pool_id});
    let body = json!({
        "jsonrpc": "2.0",
        "id": "sp1a",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": "v2.ref-finance.near",
            "method_name": "get_pool",
            "args_base64": base64::engine::general_purpose::STANDARD.encode(args.to_string())
        }
    });
    let resp = Client::new()
        .post(&input.rpc_url)
        .header("Content-Type", "application/json")
        .connect_timeout(Duration::from_secs(20))
        .body(body.to_string().as_bytes())
        .send()
        .map_err(|e| e.to_string())?;
    let bytes = resp.body().map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(&bytes)?;
    let result: Vec<u8> = parsed["result"]["result"]
        .as_array()
        .ok_or("rpc result missing")?
        .iter()
        .map(|b| b.as_u64().unwrap_or(0) as u8)
        .collect();
    let pool: Value = serde_json::from_slice(&result)?;

    let tokens = pool["token_account_ids"].as_array().ok_or("pool tokens missing")?;
    let amounts = pool["amounts"].as_array().ok_or("pool amounts missing")?;
    let amount_of = |token: &str| -> Result<u128, Failure> {
        let idx = tokens
            .iter()
            .position(|t| t.as_str() == Some(token))
            .ok_or("token not in pool")?;
        Ok(amounts[idx].as_str().ok_or("amount not string")?.parse()?)
    };
    let usdc = amount_of(&input.usdc_id)?;
    let wnear = amount_of(&input.wnear_id)?;
    if usdc == 0 || wnear == 0 {
        return Err("empty pool reserves".into());
    }
    let usdc_per_wnear = (usdc as f64 / 1e6) / (wnear as f64 / 1e24);
    Ok(json!({
        "pool": input.pool_id,
        "usdc_per_wnear": format!("{usdc_per_wnear:.6}"),
        "fee": pool["total_fee"]
    }))
}
