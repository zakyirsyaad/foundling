//! Foundling vault: a USDC vault born without access keys. See `docs/SPEC.md` for the invariants.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod cycle;
pub mod decision;
pub mod deposit;
pub mod events;
pub mod governance;
pub mod limits;
pub mod math;
pub mod policy;
pub mod pricing;
pub mod recovery;
pub mod redeem;
pub mod reveal;
pub mod selftest;
pub mod setup;
pub mod swap;

#[cfg(test)]
mod tests;

use crate::cycle::{AgentConfig, Stage};
use crate::decision::Decision;
use crate::events::emit;
use crate::governance::RoleChange;
use crate::limits::Window;
use crate::policy::Policy;
use crate::setup::SetupState;
use crate::swap::{Bucket, Inflight};

const MILLIS_PER_SECOND: u64 = 1_000;
const FULL_BPS: u32 = 10_000;
const MAX_REVEAL_DELAY: u64 = 365 * 24 * 60 * 60;
const SHA256_HEX_CHARS: usize = 64;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Token {
    Usdc,
    Wnear,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Roles {
    pub governor: AccountId,
    pub keeper: AccountId,
    pub guardian: AccountId,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Assets {
    pub usdc: AccountId,
    pub wnear: AccountId,
    pub rhea: AccountId,
    pub pool_id: u64,
    pub pool_fee_bps: u32,
    pub usdc_decimals: u8,
    pub wnear_decimals: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleConfig {
    pub account: AccountId,
    pub near_id: String,
    pub usdc_id: String,
}

#[near(serializers = [json])]
pub struct InitConfig {
    pub roles: Roles,
    pub assets: Assets,
    pub agent: AgentConfig,
    pub oracle: OracleConfig,
    pub policy: Policy,
    pub allowlist: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct Book {
    pub usdc: U128,
    pub wnear: U128,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Shares,
    NetDeposits,
    Pending,
    Claimable,
    Allowlist,
    Buckets,
    BucketClaims,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    vault_id: AccountId,
    roles: Roles,
    keeper_change: Option<RoleChange>,
    guardian_change: Option<RoleChange>,
    assets: Assets,
    agent: AgentConfig,
    oracle: OracleConfig,
    policy: Policy,
    initial_policy: Policy,
    frozen: bool,
    halted: bool,
    setup: SetupState,
    selftest_passed: bool,
    /// Change only from call return values, never from `ft_balance_of`, so a donation
    /// cannot move the share price.
    usdc_book: u128,
    wnear_book: u128,
    total_shares: u128,
    /// Sum of net deposits, the figure `tvl_cap` is held against.
    total_net: u128,
    shares: LookupMap<AccountId, u128>,
    net_deposits: LookupMap<AccountId, u128>,
    pending: IterableMap<AccountId, u128>,
    claimable: LookupMap<(AccountId, Token), u128>,
    allowlist: LookupSet<AccountId>,
    stage: Stage,
    last_nonce: u64,
    decision: Option<Decision>,
    inflight: Option<Inflight>,
    buckets: LookupMap<u64, Bucket>,
    bucket_claims: LookupMap<(u64, AccountId), u128>,
    /// What this vault put in its internal Ref account. Anyone can add to that account
    /// with `mft_transfer`, so the ledger is what counts, not the balance Ref reports.
    rhea_usdc: u128,
    rhea_wnear: u128,
    last_trigger: u64,
    ops_window: Window,
    buy_window: Window,
    sell_window: Window,
    args_hash: String,
    /// The committed parameters, exactly as opened by `reveal`.
    revealed: Option<String>,
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parent_of(account: &AccountId) -> Option<&str> {
    account.as_str().split_once('.').map(|(_, parent)| parent)
}

/// The vault is permanent, so a config mistake caught here is the only one that is free.
fn require_sound_config(config: &InitConfig, vault: &AccountId, parent: &AccountId) {
    let roles = &config.roles;
    let policy = &config.policy;
    require!(
        roles.keeper != *vault,
        "init: keeper must differ from the vault"
    );
    require!(
        roles.governor != *parent,
        "init: governor must differ from the parent"
    );
    require!(
        roles.keeper != roles.guardian,
        "init: keeper must differ from the guardian"
    );
    require!(policy.timelock > 0, "init: timelock must be set");
    require!(policy.cooldown > 0, "init: cooldown must be set");
    require!(
        policy.max_mint_per_cycle > 0,
        "init: max_mint_per_cycle must be set"
    );
    require!(
        policy.per_user_cap.0 <= policy.tvl_cap.0,
        "init: per_user_cap above tvl_cap"
    );
    require!(
        policy.epoch_len >= 2 * policy.cooldown,
        "init: epoch_len must hold two cooldowns"
    );
    require!(policy.decision_ttl > 0, "init: decision_ttl must be set");
    require!(
        policy.abort_after_blocks > 0,
        "init: abort_after_blocks must be set"
    );
    require!(
        policy.max_execution_seconds > 0,
        "init: max_execution_seconds must be set"
    );
    require!(policy.stuck_after > 0, "init: stuck_after must be set");
    require!(
        policy.halt_after > policy.stuck_after,
        "init: halt_after must pass stuck_after"
    );
    require!(
        config.assets.usdc != config.assets.wnear,
        "init: the two tokens must differ"
    );
    require!(
        config.assets.usdc_decimals <= config.assets.wnear_decimals,
        "init: usdc_decimals above wnear_decimals"
    );
    require!(
        policy.slippage_bps < FULL_BPS,
        "init: slippage_bps must stay below 100%"
    );
    require!(
        config.agent.outlayer_deposit.0 <= policy.ops_budget.0,
        "init: outlayer_deposit above ops_budget"
    );
    require!(
        config.oracle.near_id != config.oracle.usdc_id,
        "init: the two price feeds must differ"
    );
    require!(
        !config.agent.wasm_hash.is_empty(),
        "init: wasm_hash must be set"
    );
    require!(
        config.agent.max_instructions > 0,
        "init: max_instructions must be set"
    );
    require!(
        config.agent.max_memory_mb > 0,
        "init: max_memory_mb must be set"
    );
    require!(
        !config.agent.build_target.is_empty(),
        "init: build_target must be set"
    );
    require!(
        is_sha256_hex(&config.agent.commitment),
        "init: commitment must be 64 lowercase hex"
    );
    require!(
        config.agent.reveal_after > now_seconds(),
        "init: reveal_after must be in the future"
    );
    require!(
        config.agent.reveal_after <= now_seconds() + MAX_REVEAL_DELAY,
        "init: reveal_after is more than a year away"
    );
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == SHA256_HEX_CHARS
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn now_seconds() -> u64 {
    env::block_timestamp_ms() / MILLIS_PER_SECOND
}

#[near]
impl Vault {
    /// Only the parent account may initialise, so a born-sealed vault can only be
    /// configured inside the parent's CreateAccount + Transfer + DeployContract + init tx.
    #[init]
    pub fn init(config: InitConfig) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(
            parent_of(&me) == Some(caller.as_str()),
            "init: only the parent account"
        );
        require_sound_config(&config, &me, &caller);
        let args_hash = to_hex(&env::sha256(&env::input().unwrap_or_default()));
        emit("initialized", &format!(r#"{{"args_hash":"{args_hash}"}}"#));

        let mut allowlist = LookupSet::new(StorageKey::Allowlist);
        allowlist.extend(config.allowlist);
        Self {
            vault_id: me,
            roles: config.roles,
            keeper_change: None,
            guardian_change: None,
            assets: config.assets,
            agent: config.agent,
            oracle: config.oracle,
            initial_policy: config.policy.clone(),
            policy: config.policy,
            frozen: false,
            halted: false,
            setup: SetupState::default(),
            selftest_passed: false,
            usdc_book: 0,
            wnear_book: 0,
            total_shares: 0,
            total_net: 0,
            shares: LookupMap::new(StorageKey::Shares),
            net_deposits: LookupMap::new(StorageKey::NetDeposits),
            pending: IterableMap::new(StorageKey::Pending),
            claimable: LookupMap::new(StorageKey::Claimable),
            allowlist,
            stage: Stage::Idle,
            last_nonce: 0,
            decision: None,
            inflight: None,
            buckets: LookupMap::new(StorageKey::Buckets),
            bucket_claims: LookupMap::new(StorageKey::BucketClaims),
            rhea_usdc: 0,
            rhea_wnear: 0,
            last_trigger: 0,
            ops_window: Window::default(),
            buy_window: Window::default(),
            sell_window: Window::default(),
            args_hash,
            revealed: None,
        }
    }

    pub fn roles(&self) -> Roles {
        self.roles.clone()
    }

    pub fn policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn agent(&self) -> AgentConfig {
        self.agent.clone()
    }

    pub fn assets(&self) -> Assets {
        self.assets.clone()
    }

    pub fn oracle(&self) -> OracleConfig {
        self.oracle.clone()
    }

    pub fn keeper_change(&self) -> Option<RoleChange> {
        self.keeper_change.clone()
    }

    pub fn guardian_change(&self) -> Option<RoleChange> {
        self.guardian_change.clone()
    }

    pub fn book(&self) -> Book {
        Book {
            usdc: U128(self.usdc_book),
            wnear: U128(self.wnear_book),
        }
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }

    pub fn is_halted(&self) -> bool {
        self.halted
    }

    pub fn is_allowed(&self, account: AccountId) -> bool {
        self.allowlist.contains(&account)
    }

    pub fn total_shares(&self) -> U128 {
        U128(self.total_shares)
    }

    pub fn shares_of(&self, account: AccountId) -> U128 {
        U128(self.shares.get(&account).copied().unwrap_or(0))
    }

    pub fn pending_of(&self, account: AccountId) -> U128 {
        U128(self.pending.get(&account).copied().unwrap_or(0))
    }

    pub fn net_deposit_of(&self, account: AccountId) -> U128 {
        U128(self.net_deposit(&account))
    }

    pub fn claimable_of(&self, account: AccountId, token: Token) -> U128 {
        U128(self.claimable_amount(&account, token))
    }

    pub fn args_hash(&self) -> String {
        self.args_hash.clone()
    }
}

impl Vault {
    pub(crate) fn net_deposit(&self, account: &AccountId) -> u128 {
        self.net_deposits.get(account).copied().unwrap_or(0)
    }

    pub(crate) fn token_account(&self, token: Token) -> AccountId {
        match token {
            Token::Usdc => self.assets.usdc.clone(),
            Token::Wnear => self.assets.wnear.clone(),
        }
    }
}

#[cfg(test)]
impl Vault {
    pub fn set_halted_for_tests(&mut self, halted: bool) {
        self.halted = halted;
    }

    pub fn set_rhea_for_tests(&mut self, token: Token, amount: u128) {
        match token {
            Token::Usdc => self.rhea_usdc = amount,
            Token::Wnear => self.rhea_wnear = amount,
        }
    }

    pub fn set_books_for_tests(&mut self, usdc: u128, wnear: u128) {
        self.usdc_book = usdc;
        self.wnear_book = wnear;
    }

    pub fn set_ops_spent_for_tests(&mut self, amount: u128) {
        self.ops_window = self.ops_window.recorded(now_seconds(), amount);
    }

    pub fn set_max_mint_for_tests(&mut self, limit: u32) {
        self.policy.max_mint_per_cycle = limit;
    }
}
