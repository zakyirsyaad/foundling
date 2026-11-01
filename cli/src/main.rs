//! `foundling-verify check <proof.json>` prints one line per check. Exit code 0 means every
//! check held, 1 a claim failed, 2 the tool could not run.

use std::process::exit;

use foundling_verify::check;
use foundling_verify::proof::Proof;

const USAGE: &str = "usage: foundling-verify check <proof.json>";
const CLAIM_FAILED: i32 = 1;
const TOOL_FAILED: i32 = 2;

fn tool_error(message: &str) -> ! {
    eprintln!("{message}");
    exit(TOOL_FAILED);
}

#[cfg(feature = "fetch")]
fn print_collateral(quote_path: &str) {
    use dcap_qvl::collateral::{CollateralClient, PHALA_PCCS_URL};

    let quote = std::fs::read(quote_path).unwrap_or_else(|error| tool_error(&error.to_string()));
    let Ok(client) = CollateralClient::with_default_http(PHALA_PCCS_URL) else {
        tool_error("cannot build the HTTP client");
    };
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        tool_error("cannot start the runtime");
    };
    let collateral = runtime
        .block_on(client.fetch(&quote))
        .unwrap_or_else(|error| tool_error(&error.to_string()));
    let text =
        serde_json::to_string(&collateral).unwrap_or_else(|error| tool_error(&error.to_string()));
    println!("{text}");
}

fn check_file(path: &str) {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| tool_error(&error.to_string()));
    let proof: Proof =
        serde_json::from_str(&text).unwrap_or_else(|error| tool_error(&error.to_string()));
    let report = check(&proof);
    for line in &report.lines {
        println!("{line}");
    }
    println!("{}", report.summary());
    if report.failed > 0 {
        exit(CLAIM_FAILED);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["check", path] => check_file(path),
        #[cfg(feature = "fetch")]
        ["collateral", quote_path] => print_collateral(quote_path),
        _ => tool_error(USAGE),
    }
}
