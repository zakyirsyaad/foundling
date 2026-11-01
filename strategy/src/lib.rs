//! The pure part of the strategy, shared with `verify replay`. `decide` reads only what the
//! Decision and the vault's input record, so it can be re-run from chain. Stdin, the secret
//! and the sockets stay in `main.rs`; raw replies of the price sources are read in `sources`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const COMMITMENT_TAG: &[u8] = b"foundling/v1/commitment";
const DECISION_VERSION: u32 = 1;
const INPUT_VERSION: u32 = 1;
const SALT_BYTES: usize = 32;
const BPS: u128 = 10_000;
/// `reveal` publishes the prompt, so its size is part of what that call has to carry.
const MAX_PROMPT_BYTES: usize = 2_000;
/// Older than this, a source counts as dead. A quiet market can go two minutes without a trade.
const MAX_SOURCE_AGE_SECONDS: u64 = 300;
#[cfg(feature = "rehearsal")]
const REHEARSAL_CHAIN: &str = "testnet";

pub const AI_CLEAR: u8 = 0;
pub const AI_FLAGGED: u8 = 1;
/// The advisor gave no valid answer, which ends in a hold whatever the prices say.
pub const AI_SILENT: u8 = 2;

pub mod advisor;
pub mod sizing;
pub mod sources;

pub use advisor::Observed;
pub use sizing::Limits;

/// u128 as a decimal string, the only safe form for JSON readers.
pub(crate) mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    #[serde(with = "decimal")]
    pub risk_on_above: u128,
    #[serde(with = "decimal")]
    pub risk_off_below: u128,
    #[serde(with = "decimal")]
    pub source_dev_bps: u128,
    #[serde(with = "decimal")]
    pub buy_usdc: u128,
    #[serde(with = "decimal")]
    pub sell_wnear: u128,
    /// Sealed with the numbers: a prompt compiled into a public WASM would be no secret.
    pub prompt: String,
}

// Canonical forms are fixed text, not serde output: any crate in a build can switch on
// `serde_json/preserve_order`, near-sdk does, and that changes key order. The vault's
// `reveal` has to produce these same bytes.
impl Params {
    pub fn canonical(&self) -> String {
        format!(
            r#"{{"buy_usdc":"{}","prompt":{},"risk_off_below":"{}","risk_on_above":"{}","sell_wnear":"{}","source_dev_bps":"{}"}}"#,
            self.buy_usdc,
            serde_json::Value::from(self.prompt.as_str()),
            self.risk_off_below,
            self.risk_on_above,
            self.sell_wnear,
            self.source_dev_bps,
        )
    }

    /// The secret cannot be changed once its owner's keys are gone, so a bad set is
    /// refused here and the vault ends the cycle.
    fn is_sound(&self) -> bool {
        self.risk_off_below < self.risk_on_above
            && self.buy_usdc > 0
            && self.sell_wnear > 0
            && (1..=BPS).contains(&self.source_dev_bps)
            && !self.prompt.is_empty()
            && self.prompt.len() <= MAX_PROMPT_BYTES
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Input {
    pub v: u32,
    pub vault: String,
    pub nonce: u64,
    pub now: u64,
    #[serde(with = "decimal")]
    pub usdc_book: u128,
    #[serde(with = "decimal")]
    pub wnear_book: u128,
    #[serde(with = "decimal")]
    pub window_buy: u128,
    #[serde(with = "decimal")]
    pub window_sell: u128,
    pub limits: Limits,
}

/// Every market input of a decision, carried in the Decision so replay needs no archive.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Obs {
    #[serde(with = "decimal")]
    pub pa: u128,
    #[serde(with = "decimal")]
    pub pb: u128,
    pub ta: u64,
    pub tb: u64,
    pub ai_flag: u8,
    pub ai_conf: u8,
}

impl Obs {
    /// What a run records when the market could not be read.
    fn unread() -> Self {
        Self {
            pa: 0,
            pb: 0,
            ta: 0,
            tb: 0,
            ai_flag: AI_SILENT,
            ai_conf: 0,
        }
    }

    pub fn canonical(&self) -> String {
        format!(
            r#"{{"ai_conf":{},"ai_flag":{},"pa":"{}","pb":"{}","ta":{},"tb":{}}}"#,
            self.ai_conf, self.ai_flag, self.pa, self.pb, self.ta, self.tb,
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Secret {
    pub chain: String,
    pub wasm_hash: String,
    /// 32 bytes in hex.
    pub salt: String,
    pub params: Params,
    /// Without it the advisor stays silent. It never leaves for anywhere but NEAR AI, and
    /// `reveal` does not publish it.
    #[serde(default)]
    pub ai_key: Option<String>,
    #[cfg(feature = "rehearsal")]
    #[serde(default)]
    pub rehearsal_obs: Option<Obs>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Regime {
    RiskOn,
    RiskOff,
    Undetermined,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    None,
    BuyRisk,
    SellRisk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub regime: Regime,
    pub action: Action,
    pub amount_in: u128,
    pub ref_price: u128,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct AiRef {
    pub chat_id: String,
    pub resp_sig_hash: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Decision {
    pub v: u32,
    pub vault: String,
    pub chain: String,
    pub nonce: u64,
    pub regime: Regime,
    pub action: Action,
    #[serde(with = "decimal")]
    pub amount_in: u128,
    #[serde(with = "decimal")]
    pub ref_price: u128,
    pub commitment: String,
    pub inputs_digest: String,
    pub obs: Obs,
    pub ai_ref: AiRef,
    pub wasm_hash: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadInput;

/// A failure of any input is a hold, never a sell: otherwise whoever can make the two
/// sources disagree could force churn that burns slippage every window.
pub fn decide(params: &Params, input: &Input, obs: &Obs) -> Verdict {
    let regime = regime_of(params, input.now, obs);
    let (action, wanted, room) = match regime {
        Regime::RiskOn if obs.ai_flag == AI_CLEAR => (
            Action::BuyRisk,
            params.buy_usdc,
            sizing::buy_room(input, obs.pb),
        ),
        Regime::RiskOff => (
            Action::SellRisk,
            params.sell_wnear,
            sizing::sell_room(input),
        ),
        _ => return hold(regime, obs.pb),
    };
    let amount_in = wanted.min(room);
    if amount_in == 0 {
        return hold(regime, obs.pb);
    }
    Verdict {
        regime,
        action,
        amount_in,
        ref_price: obs.pb,
    }
}

/// Thresholds read `pb` only: the pool price can be pushed by anyone with capital.
fn regime_of(params: &Params, now: u64, obs: &Obs) -> Regime {
    if obs.ai_flag > AI_FLAGGED || !sources_agree(obs, now, params.source_dev_bps) {
        return Regime::Undetermined;
    }
    if obs.pb >= params.risk_on_above {
        Regime::RiskOn
    } else if obs.pb <= params.risk_off_below {
        Regime::RiskOff
    } else {
        Regime::Undetermined
    }
}

fn sources_agree(obs: &Obs, now: u64, max_dev_bps: u128) -> bool {
    let is_fresh = |seen: u64| seen.abs_diff(now) <= MAX_SOURCE_AGE_SECONDS;
    if obs.pa == 0 || obs.pb == 0 || !is_fresh(obs.ta) || !is_fresh(obs.tb) {
        return false;
    }
    let gap = obs.pa.abs_diff(obs.pb).checked_mul(BPS);
    let allowed = obs.pb.checked_mul(max_dev_bps);
    matches!((gap, allowed), (Some(gap), Some(allowed)) if gap <= allowed)
}

fn hold(regime: Regime, ref_price: u128) -> Verdict {
    Verdict {
        regime,
        action: Action::None,
        amount_in: 0,
        ref_price,
    }
}

pub fn commitment(
    chain: &str,
    vault: &str,
    wasm_hash: &str,
    params: &Params,
    salt: &[u8],
) -> String {
    hash_fields(
        COMMITMENT_TAG,
        &[
            chain.as_bytes(),
            vault.as_bytes(),
            wasm_hash.as_bytes(),
            params.canonical().as_bytes(),
            salt,
        ],
    )
}

pub fn inputs_digest(input_data: &str, obs: &Obs, resp_sig_hash: &str) -> String {
    hash_fields(
        b"",
        &[
            input_data.as_bytes(),
            obs.canonical().as_bytes(),
            resp_sig_hash.as_bytes(),
        ],
    )
}

/// Each field carries its length, so two fields can never be re-cut into two others.
fn hash_fields(tag: &[u8], fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tag);
    for field in fields {
        hasher.update((field.len() as u32).to_be_bytes());
        hasher.update(field);
    }
    to_hex(&hasher.finalize())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) || !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|start| u8::from_str_radix(&text[start..start + 2], 16).ok())
        .collect()
}

fn open_secret(raw: &str) -> Option<(Secret, Vec<u8>)> {
    let secret: Secret = serde_json::from_str(raw).ok()?;
    if !secret.params.is_sound() {
        return None;
    }
    let salt = from_hex(&secret.salt).filter(|salt| salt.len() == SALT_BYTES)?;
    Some((secret, salt))
}

/// A rehearsal binary reads prices from the secret, which are whatever the creator wrote,
/// so it holds on every chain but testnet. A secret is sealed once and cannot stay fresh,
/// so the prices take the vault's clock.
#[cfg(feature = "rehearsal")]
pub fn rehearsal_observe(secret: &Secret, input: &Input) -> Option<Observed> {
    if secret.chain != REHEARSAL_CHAIN {
        return None;
    }
    let obs = secret.rehearsal_obs.clone()?;
    let stamped = Obs {
        ta: input.now,
        tb: input.now,
        ..obs
    };
    Some(stamped.into())
}

/// OutLayer runs a binary that has no secret row, just without the secret. This answer
/// carries no commitment, so the vault ends the cycle and nothing trades.
fn answer_without_secret(input: &Input) -> Decision {
    Decision {
        v: DECISION_VERSION,
        vault: input.vault.clone(),
        chain: String::new(),
        nonce: input.nonce,
        regime: Regime::Undetermined,
        action: Action::None,
        amount_in: 0,
        ref_price: 0,
        commitment: String::new(),
        inputs_digest: String::new(),
        obs: Obs::unread(),
        ai_ref: AiRef::default(),
        wasm_hash: String::new(),
    }
}

/// Answers one run. `observe` is the only way market data gets in.
pub fn respond(
    input_data: &str,
    secret: Option<&str>,
    observe: impl FnOnce(&Secret, &Input) -> Option<Observed>,
) -> Result<Decision, BadInput> {
    let input: Input = serde_json::from_str(input_data).map_err(|_| BadInput)?;
    if input.v != INPUT_VERSION {
        return Err(BadInput);
    }
    let Some((secret, salt)) = secret.and_then(open_secret) else {
        return Ok(answer_without_secret(&input));
    };
    let Observed { obs, ai_ref } = observe(&secret, &input).unwrap_or_else(|| Obs::unread().into());
    let verdict = decide(&secret.params, &input, &obs);
    Ok(Decision {
        v: DECISION_VERSION,
        chain: secret.chain.clone(),
        nonce: input.nonce,
        regime: verdict.regime,
        action: verdict.action,
        amount_in: verdict.amount_in,
        ref_price: verdict.ref_price,
        commitment: commitment(
            &secret.chain,
            &input.vault,
            &secret.wasm_hash,
            &secret.params,
            &salt,
        ),
        inputs_digest: inputs_digest(input_data, &obs, &ai_ref.resp_sig_hash),
        obs,
        ai_ref,
        wasm_hash: secret.wasm_hash,
        vault: input.vault,
    })
}

#[cfg(test)]
mod advisor_tests;
#[cfg(test)]
mod sources_tests;
#[cfg(test)]
mod tests;
