//! Foundling vault: a USDC vault born without access keys. See `docs/SPEC.md` for the invariants.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod deposit;
pub mod events;
pub mod governance;
pub mod limits;
pub mod math;
pub mod policy;
pub mod redeem;
pub mod setup;

#[cfg(test)]
mod tests;

use crate::events::emit;
use crate::governance::RoleChange;
use crate::policy::Policy;
use crate::setup::SetupState;

const MILLIS_PER_SECOND: u64 = 1_000;

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
}

#[near(serializers = [json])]
pub struct InitConfig {
    pub roles: Roles,
    pub assets: Assets,
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
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    roles: Roles,
    keeper_change: Option<RoleChange>,
    guardian_change: Option<RoleChange>,
    assets: Assets,
    policy: Policy,
    initial_policy: Policy,
    frozen: bool,
    halted: bool,
    setup: SetupState,
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
    last_trigger: u64,
    args_hash: String,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parent_of(account: &AccountId) -> Option<&str> {
    account.as_str().split_once('.').map(|(_, parent)| parent)
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
        let args_hash = to_hex(&env::sha256(&env::input().unwrap_or_default()));
        emit("initialized", &format!(r#"{{"args_hash":"{args_hash}"}}"#));

        let mut allowlist = LookupSet::new(StorageKey::Allowlist);
        allowlist.extend(config.allowlist);
        Self {
            roles: config.roles,
            keeper_change: None,
            guardian_change: None,
            assets: config.assets,
            initial_policy: config.policy.clone(),
            policy: config.policy,
            frozen: false,
            halted: false,
            setup: SetupState::default(),
            usdc_book: 0,
            wnear_book: 0,
            total_shares: 0,
            total_net: 0,
            shares: LookupMap::new(StorageKey::Shares),
            net_deposits: LookupMap::new(StorageKey::NetDeposits),
            pending: IterableMap::new(StorageKey::Pending),
            claimable: LookupMap::new(StorageKey::Claimable),
            allowlist,
            last_trigger: 0,
            args_hash,
        }
    }

    pub fn roles(&self) -> Roles {
        self.roles.clone()
    }

    pub fn policy(&self) -> Policy {
        self.policy.clone()
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

    pub fn set_books_for_tests(&mut self, usdc: u128, wnear: u128) {
        self.usdc_book = usdc;
        self.wnear_book = wnear;
    }

    pub fn set_max_mint_for_tests(&mut self, limit: u32) {
        self.policy.max_mint_per_cycle = limit;
    }
}
