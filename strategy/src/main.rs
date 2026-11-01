//! The WASM shell: stdin is the vault's `input_data`, the secret arrives as an environment
//! variable, and stdout is Decision v1.

use std::io::{self, Read, Write};
use std::process::exit;

#[cfg(all(target_arch = "wasm32", not(feature = "rehearsal")))]
mod http;

#[cfg(feature = "rehearsal")]
use foundling_strategy::rehearsal_observe as observe;
use foundling_strategy::respond;
#[cfg(all(not(target_arch = "wasm32"), not(feature = "rehearsal")))]
use foundling_strategy::{Input, Observed, Secret};
#[cfg(all(target_arch = "wasm32", not(feature = "rehearsal")))]
use http::observe;

const SECRET_NAME: &str = "FOUNDLING_SECRET";

// Covered by the WASM hash, so these door rules cannot change without a new hash.
#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = "outlayer.manifest")]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

// The host build has no sockets, so it answers as if every source had failed.
#[cfg(all(not(target_arch = "wasm32"), not(feature = "rehearsal")))]
fn observe(_secret: &Secret, _input: &Input) -> Option<Observed> {
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
