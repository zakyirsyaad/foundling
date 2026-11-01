//! Opening the sealed strategy parameters once `reveal_after` has passed, so every past
//! decision can be replayed against them. The parameters stay opaque text here: the
//! commitment covers these exact bytes, and their schema belongs to the strategy, which
//! can grow after this contract is sealed.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::events::emit;
use crate::{now_seconds, to_hex, Vault, VaultExt};

const COMMITMENT_TAG: &[u8] = b"foundling/v1/commitment";
const SALT_BYTES: usize = 32;

#[near]
impl Vault {
    /// Anyone may call it. A failed attempt still publishes its arguments on chain.
    pub fn reveal(&mut self, params: String, salt: String) {
        require!(now_seconds() >= self.agent.reveal_after, "TOO_EARLY");
        require!(self.revealed.is_none(), "ALREADY_REVEALED");
        let Some(salt_bytes) = from_hex(&salt).filter(|bytes| bytes.len() == SALT_BYTES) else {
            env::panic_str("BAD_SALT");
        };
        require!(
            self.commitment_of(params.as_bytes(), &salt_bytes) == self.agent.commitment,
            "BAD_REVEAL"
        );
        // The text can outgrow the log limit, so it is read from `revealed`.
        emit("revealed", &json!({ "salt": salt }).to_string());
        self.revealed = Some(params);
    }

    pub fn revealed(&self) -> Option<String> {
        self.revealed.clone()
    }

    pub fn reveal_after(&self) -> u64 {
        self.agent.reveal_after
    }
}

impl Vault {
    /// Each field carries its length, so two fields can never be re-cut into two others.
    fn commitment_of(&self, params: &[u8], salt: &[u8]) -> String {
        let fields = [
            self.agent.chain.as_bytes(),
            self.vault_id.as_bytes(),
            self.agent.wasm_hash.as_bytes(),
            params,
            salt,
        ];
        let mut preimage = COMMITMENT_TAG.to_vec();
        for field in fields {
            preimage.extend_from_slice(&(field.len() as u32).to_be_bytes());
            preimage.extend_from_slice(field);
        }
        to_hex(&env::sha256(&preimage))
    }
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
