//! SP1a diagnostic probe: reports what the secret door, NEAR AI, and the two public price
//! sources look like from inside an OutLayer worker, so Gate A can be judged from real
//! replies instead of guesses. This binary never produces a Decision and is not the
//! strategy; it only has to survive one run inside the budget below and say honestly what
//! it saw. Modes: `normal` (all four probes), `big` (oversized reply, tests the 1024-byte
//! resume limit), `fail` (deliberate `Failed`, tests that OutLayer reports it as such), and
//! `sleep` (deliberate overrun, tests the 45-second execution limit). Any other `mode`,
//! unreadable stdin, or input that does not parse is a hard failure (exit 1), never a
//! silent "normal" run. Only builds for wasm32: there is no socket on the host, and this
//! probe has no Decision-shaped fallback to answer with instead.

fn main() {
    #[cfg(target_arch = "wasm32")]
    wasm::run();
    #[cfg(not(target_arch = "wasm32"))]
    {
        eprintln!("sp1a-probe only runs on wasm32-wasip2 (cargo build --target wasm32-wasip2)");
        std::process::exit(1);
    }
}

/// Plain base64 (RFC 4648, with padding), not wasm32-specific: kept at the crate root, not
/// inside `wasm`, so it can be unit-tested on the host instead of only compiling untested.
/// The host build has no caller for it outside `#[cfg(test)]` — `wasm::run` is its only
/// caller on wasm32, where this is not dead code.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18 & 0x3f) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod base64_tests {
    use super::encode_base64;

    #[test]
    fn known_vectors_match_rfc_4648() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn matches_the_pool_id_payload_this_probe_actually_sends() {
        // {"pool_id":4512} — this is the literal args_base64 the probe puts on the wire
        // for `get_pool`; if this ever drifts from what Rhea expects, the probe is
        // silently asking for the wrong pool rather than reporting a clean error.
        assert_eq!(
            encode_base64(br#"{"pool_id":4512}"#),
            "eyJwb29sX2lkIjo0NTEyfQ=="
        );
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::env;
    use std::io::{self, Read, Write};
    use std::process::exit;

    use serde::Deserialize;
    use serde_json::{json, Value};
    use wasip2::clocks::monotonic_clock;
    use wasip2::http::outgoing_handler;
    use wasip2::http::types::{
        Fields, IncomingResponse, Method, OutgoingBody, OutgoingRequest, Scheme,
    };
    use wasip2::io::poll::{self, Pollable};
    use wasip2::io::streams::StreamError;

    // Covered by the WASM hash, like `main.rs`'s. Deny both doors before any secret read,
    // so a relay or a direct HTTPS call cannot reach this probe's secret either.
    #[used]
    #[unsafe(link_section = "outlayer.manifest")]
    static OUTLAYER_MANIFEST: [u8; include_bytes!("../../manifest.json").len()] =
        *include_bytes!("../../manifest.json");

    const BUILD_ID: &str = match option_env!("SP1A_BUILD_ID") {
        Some(id) => id,
        None => "dev",
    };
    const SECRET_VAR: &str = "SP1A_PROBE_SECRET";
    const NEAR_AI_KEY_VAR: &str = "NEAR_AI_API_KEY";
    const NEAR_AI_HOST: &str = "cloud-api.near.ai";
    const NEAR_AI_PATH: &str = "/v1/chat/completions";
    // Fixed, never taken from input: a wasm-hash-bound secret only has to leak once
    // through an attacker-chosen model name for every later run on that hash to lose its
    // credit budget.
    const NEAR_AI_MODEL: &str = "z-ai/glm-5.3-flash";
    const NEAR_AI_MAX_TOKENS: u32 = 64;

    // Same sources and hosts as `foundling_strategy::sources`, so a passing probe means
    // the strategy's own egress works, not just that some CEX and some RPC answer.
    const CEX_HOST: &str = "api.kraken.com";
    const CEX_PATH: &str = "/0/public/Trades?pair=NEARUSD&count=1";
    const RHEA_RPC_HOST: &str = "free.rpc.fastnear.com";
    const RHEA_RPC_PATH: &str = "/";
    const REF: &str = "v2.ref-finance.near";
    const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const WNEAR: &str = "wrap.near";
    const POOL_ID: u64 = 4512;

    /// One budget for every remaining network step, on the WASM's own clock. OutLayer's
    /// limit is 45s (SPEC); four sequential calls with their own 20-30s connect timeouts
    /// could total 90s and never show which source stuck. Held well under 45s so a run
    /// that cannot finish in time still prints whatever it already has, instead of
    /// becoming a billed, blank `null`.
    const RUN_BUDGET_NANOS: u64 = 30_000_000_000;
    const MAX_REPLY_BYTES: usize = 256 * 1024;
    const READ_CHUNK_BYTES: u64 = 16 * 1024;
    /// `sleep` mode's own clock, independent of `RUN_BUDGET_NANOS`: this mode exists to be
    /// killed by OutLayer's limit, not to respect this probe's budget.
    const SLEEP_POLL_NANOS: u64 = 500_000_000;

    #[derive(Deserialize)]
    struct Input {
        mode: String,
        #[serde(default = "default_sleep_seconds")]
        sleep_seconds: u64,
    }

    fn default_sleep_seconds() -> u64 {
        60
    }

    fn fail(message: &str) -> ! {
        eprintln!("sp1a-probe: {message}");
        exit(1);
    }

    pub fn run() {
        let mut raw = String::new();
        if io::stdin().read_to_string(&mut raw).is_err() {
            fail("cannot read stdin");
        }
        let Ok(input) = serde_json::from_str::<Input>(&raw) else {
            fail("bad input: `mode` must be one of normal, big, fail, sleep");
        };
        match input.mode.as_str() {
            "normal" => run_normal(),
            "big" => run_big(),
            "fail" => fail("deliberate failure (mode=fail)"),
            "sleep" => run_sleep(input.sleep_seconds.max(1)),
            other => fail(&format!("unknown mode: {other}")),
        }
    }

    fn run_big() {
        // Deliberately over the 1024-byte resume limit (SPEC), to see how OutLayer and
        // the calling contract handle an oversize reply. Not a failure: exits 0.
        print_and_exit(json!({"v": 1, "build": BUILD_ID, "mode": "big", "pad": "x".repeat(1200)}));
    }

    fn run_sleep(seconds: u64) {
        // A real deadline, not `std::thread::sleep`: this target has no OS thread to
        // park, and the point is for OutLayer's own 45s/200-block limit to end the run,
        // not this probe.
        let until = monotonic_clock::now() + seconds.saturating_mul(1_000_000_000);
        while monotonic_clock::now() < until {
            poll::poll(&[&monotonic_clock::subscribe_instant(
                monotonic_clock::now() + SLEEP_POLL_NANOS,
            )]);
        }
        print_and_exit(json!({"v": 1, "build": BUILD_ID, "mode": "sleep", "slept_s": seconds}));
    }

    fn run_normal() {
        let deadline = monotonic_clock::now() + RUN_BUDGET_NANOS;
        let out = json!({
            "v": 1,
            "build": BUILD_ID,
            "mode": "normal",
            "secret": probe(secret_info()),
            "nearai": probe(nearai_reply(deadline)),
            "cex": probe(cex_price(deadline)),
            "rhea": probe(rhea_spot(deadline)),
        });
        print_and_exit(out);
    }

    fn print_and_exit(out: Value) -> ! {
        let mut stdout = io::stdout();
        if writeln!(stdout, "{out}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            fail("cannot write stdout");
        }
        exit(0);
    }

    /// Every probe step reports what it found, status included, even when parsing the
    /// body failed — a parse failure is itself a result (not throwing away the HTTP
    /// status is the one thing a diagnostic probe cannot skip).
    fn probe(step: Result<Value, String>) -> Value {
        step.unwrap_or_else(|message| json!({"err": message.chars().take(200).collect::<String>()}))
    }

    fn secret_info() -> Result<Value, String> {
        Ok(json!({"present": env::var(SECRET_VAR).is_ok()}))
    }

    fn nearai_reply(deadline: u64) -> Result<Value, String> {
        let key = match env::var(NEAR_AI_KEY_VAR) {
            Ok(key) if !key.is_empty() => key,
            _ => return Ok(json!({"present": false})),
        };
        let body = json!({
            "model": NEAR_AI_MODEL,
            "messages": [{"role": "user", "content": "Reply with the single word OK."}],
            "max_tokens": NEAR_AI_MAX_TOKENS,
            "temperature": 0,
            "stream": false
        });
        let auth = format!("Bearer {key}");
        let headers: [(&str, &str); 2] = [("authorization", &auth), ("x-no-aliasing", "true")];
        let (status, bytes) = fetch(
            NEAR_AI_HOST,
            NEAR_AI_PATH,
            Some(body.to_string()),
            &headers,
            deadline,
        )?;
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(json!({"status": status, "err": "reply is not JSON"})),
        };
        if status != 200 {
            return Ok(json!({"status": status, "err": parsed["error"]["message"]}));
        }
        let choice = &parsed["choices"][0];
        Ok(json!({
            "status": status,
            "model": parsed["model"],
            "finish_reason": choice["finish_reason"],
            "reply": choice["message"]["content"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>(),
        }))
    }

    fn cex_price(deadline: u64) -> Result<Value, String> {
        let (status, bytes) = fetch(CEX_HOST, CEX_PATH, None, &[], deadline)?;
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(json!({"status": status, "err": "reply is not JSON"})),
        };
        let errors_empty = parsed["error"]
            .as_array()
            .is_none_or(|rows| rows.is_empty());
        if status != 200 || !errors_empty {
            return Ok(json!({"status": status, "err": parsed["error"]}));
        }
        let row = parsed["result"]["NEARUSD"][0].clone();
        Ok(json!({"status": status, "price": row[0], "time": row[2]}))
    }

    fn rhea_spot(deadline: u64) -> Result<Value, String> {
        let args = json!({"pool_id": POOL_ID});
        let body = json!({
            "jsonrpc": "2.0",
            "id": "sp1a-probe",
            "method": "query",
            "params": {
                "request_type": "call_function",
                "finality": "final",
                "account_id": REF,
                "method_name": "get_pool",
                "args_base64": encode_base64(args.to_string().as_bytes()),
            }
        });
        let (status, bytes) = fetch(
            RHEA_RPC_HOST,
            RHEA_RPC_PATH,
            Some(body.to_string()),
            &[],
            deadline,
        )?;
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(json!({"status": status, "err": "reply is not JSON"})),
        };
        if status != 200 {
            return Ok(json!({"status": status, "err": parsed["error"]["message"]}));
        }
        let Some(result) = parsed["result"]["result"].as_array() else {
            return Ok(json!({"status": status, "err": "rpc result missing"}));
        };
        let raw: Vec<u8> = result
            .iter()
            .filter_map(|b| b.as_u64())
            .map(|b| b as u8)
            .collect();
        if raw.len() != result.len() {
            return Ok(json!({"status": status, "err": "rpc result has a non-byte element"}));
        }
        let pool: Value = match serde_json::from_slice(&raw) {
            Ok(pool) => pool,
            Err(_) => return Ok(json!({"status": status, "err": "pool reply is not JSON"})),
        };
        let Some(tokens) = pool["token_account_ids"].as_array() else {
            return Ok(json!({"status": status, "err": "pool tokens missing"}));
        };
        let Some(amounts) = pool["amounts"].as_array() else {
            return Ok(json!({"status": status, "err": "pool amounts missing"}));
        };
        let amount_of = |token: &str| -> Option<u128> {
            let idx = tokens.iter().position(|t| t.as_str() == Some(token))?;
            amounts.get(idx)?.as_str()?.parse().ok()
        };
        let (Some(usdc), Some(wnear)) = (amount_of(USDC), amount_of(WNEAR)) else {
            return Ok(json!({"status": status, "err": "pool token or amount missing"}));
        };
        if usdc == 0 || wnear == 0 {
            return Ok(json!({"status": status, "err": "empty pool reserves"}));
        }
        let usdc_per_wnear = (usdc as f64 / 1e6) / (wnear as f64 / 1e24);
        Ok(json!({
            "status": status,
            "usdc_per_wnear": format!("{usdc_per_wnear:.6}"),
            "fee": pool["total_fee"],
        }))
    }

    // --- wasi:http plumbing below, one budget and one reply cap for every call,
    // mirroring `strategy/src/http.rs` (duplicated rather than imported: this probe is
    // not the strategy and should not change if the strategy's HTTP module does). ---

    fn fetch(
        host: &str,
        path: &str,
        body: Option<String>,
        extra_headers: &[(&str, &str)],
        deadline: u64,
    ) -> Result<(u16, Vec<u8>), String> {
        let headers = Fields::new();
        if body.is_some() {
            headers
                .append("content-type", b"application/json")
                .map_err(|_| "bad header".to_string())?;
        }
        for (name, value) in extra_headers {
            headers
                .append(name, value.as_bytes())
                .map_err(|_| "bad header".to_string())?;
        }
        let outgoing = OutgoingRequest::new(headers);
        let method = if body.is_some() {
            Method::Post
        } else {
            Method::Get
        };
        outgoing.set_method(&method).map_err(|_| "bad method")?;
        outgoing
            .set_scheme(Some(&Scheme::Https))
            .map_err(|_| "bad scheme")?;
        outgoing
            .set_authority(Some(host))
            .map_err(|_| "bad authority")?;
        outgoing
            .set_path_with_query(Some(path))
            .map_err(|_| "bad path")?;
        write_body(&outgoing, body.as_deref())?;
        let pending = outgoing_handler::handle(outgoing, None).map_err(|e| e.to_string())?;
        wait_for(&pending.subscribe(), deadline)?;
        let response = pending
            .get()
            .ok_or("no response from the host")?
            .map_err(|_| "request already taken".to_string())?
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let bytes = read_body(&response, deadline)?;
        Ok((status, bytes))
    }

    fn write_body(outgoing: &OutgoingRequest, body: Option<&str>) -> Result<(), String> {
        let writer = outgoing.body().map_err(|_| "cannot open request body")?;
        if let Some(body) = body {
            let stream = writer.write().map_err(|_| "cannot write request body")?;
            stream
                .blocking_write_and_flush(body.as_bytes())
                .map_err(|_| "cannot send request body")?;
        }
        OutgoingBody::finish(writer, None).map_err(|_| "cannot finish request body".to_string())
    }

    fn wait_for(ready: &Pollable, deadline: u64) -> Result<(), String> {
        let timer = monotonic_clock::subscribe_instant(deadline);
        if poll::poll(&[ready, &timer]).contains(&0) {
            Ok(())
        } else {
            Err("timed out".to_string())
        }
    }

    fn read_body(response: &IncomingResponse, deadline: u64) -> Result<Vec<u8>, String> {
        let body = response
            .consume()
            .map_err(|_| "cannot read response body")?;
        let stream = body.stream().map_err(|_| "cannot open response stream")?;
        let ready = stream.subscribe();
        let mut reply = Vec::new();
        while reply.len() <= MAX_REPLY_BYTES {
            wait_for(&ready, deadline)?;
            match stream.read(READ_CHUNK_BYTES) {
                Ok(chunk) => reply.extend_from_slice(&chunk),
                Err(StreamError::Closed) => return Ok(reply),
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("reply larger than the cap".to_string())
    }

    use super::encode_base64;
}
