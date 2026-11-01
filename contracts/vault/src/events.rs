//! NEP-297 events. `verify` reads these, so names change only together with it.

use near_sdk::env;

const EVENT_STANDARD: &str = "foundling";
const EVENT_VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}
