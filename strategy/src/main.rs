//! The WASM shell: stdin is the vault's `input_data`, the secret arrives as an environment
//! variable, and stdout is Decision v1.

use std::io::{self, Read, Write};
use std::process::exit;

#[cfg(feature = "rehearsal")]
use foundling_strategy::rehearsal_observe as observe;
use foundling_strategy::respond;
#[cfg(not(feature = "rehearsal"))]
use foundling_strategy::{
    sources::{observe_market, Call},
    Obs, Secret,
};

const SECRET_NAME: &str = "FOUNDLING_SECRET";
#[cfg(all(target_arch = "wasm32", not(feature = "rehearsal")))]
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
#[cfg(all(target_arch = "wasm32", not(feature = "rehearsal")))]
const STATUS_OK: u16 = 200;

// Covered by the WASM hash, so these door rules cannot change without a new hash.
#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = "outlayer.manifest")]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(not(feature = "rehearsal"))]
fn observe(_secret: &Secret) -> Option<Obs> {
    observe_market(send)
}

#[cfg(all(target_arch = "wasm32", not(feature = "rehearsal")))]
fn send(call: &Call) -> Option<Vec<u8>> {
    let client = wasi_http_client::Client::new();
    let request = match &call.body {
        Some(body) => client
            .post(call.url)
            .header("Content-Type", "application/json")
            .body(body.as_bytes()),
        None => client.get(call.url),
    };
    let response = request.connect_timeout(CONNECT_TIMEOUT).send().ok()?;
    if response.status() != STATUS_OK {
        return None;
    }
    response.body().ok()
}

// The host build has no sockets, so it answers as if every source had failed.
#[cfg(all(not(target_arch = "wasm32"), not(feature = "rehearsal")))]
fn send(_call: &Call) -> Option<Vec<u8>> {
    None
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    exit(1);
}

fn main() {
    let mut input_data = String::new();
    if io::stdin().read_to_string(&mut input_data).is_err() {
        fail("cannot read stdin");
    }
    let secret = std::env::var(SECRET_NAME).ok();
    let Ok(decision) = respond(&input_data, secret.as_deref(), observe) else {
        fail("bad input");
    };
    let Ok(answer) = serde_json::to_string(&decision) else {
        fail("cannot encode the decision");
    };
    let mut stdout = io::stdout();
    if stdout
        .write_all(answer.as_bytes())
        .and_then(|()| stdout.flush())
        .is_err()
    {
        fail("cannot write stdout");
    }
}
