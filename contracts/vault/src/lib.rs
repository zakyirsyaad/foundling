//! SP9 stub: roles, parent-only init and events of the Foundling vault, no vault logic.

use near_sdk::{env, near, require, AccountId, PanicOnDefault};

const EVENT_STANDARD: &str = "foundling";
const EVENT_VERSION: &str = "1.0.0";
const STUB_VERSION: &str = "sp9-0.1.0";

#[near(serializers = [json])]
pub struct SelfTest {
    pub version: String,
    pub args_hash: String,
    pub governor: AccountId,
    pub keeper: AccountId,
    pub guardian: AccountId,
    pub frozen: bool,
    pub cycles: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    governor: AccountId,
    keeper: AccountId,
    guardian: AccountId,
    frozen: bool,
    cycles: u64,
    args_hash: String,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn emit(event: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}

fn parent_of(account: &AccountId) -> Option<&str> {
    account.as_str().split_once('.').map(|(_, parent)| parent)
}

#[near]
impl Vault {
    /// Only the parent account may initialise, so a born-sealed vault can only be
    /// configured inside the parent's CreateAccount + Transfer + DeployContract + init tx.
    #[init]
    pub fn init(governor: AccountId, keeper: AccountId, guardian: AccountId) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(parent_of(&me) == Some(caller.as_str()), "init: only the parent account");
        let args_hash = to_hex(&env::sha256(&env::input().unwrap_or_default()));
        emit("initialized", &format!(r#"{{"args_hash":"{args_hash}"}}"#));
        Self { governor, keeper, guardian, frozen: false, cycles: 0, args_hash }
    }

    // Keeper methods (the keeper FCK allows exactly these five).
    pub fn trigger_cycle(&mut self) {
        self.only(&self.keeper.clone(), "keeper");
        require!(!self.frozen, "frozen");
        self.cycles += 1;
        emit("cycle_triggered", &format!(r#"{{"cycle":{}}}"#, self.cycles));
    }

    pub fn execute_decision(&mut self) {
        self.keeper_noop("execute_decision");
    }

    pub fn advance(&mut self) {
        self.keeper_noop("advance");
    }

    pub fn abort_stale_cycle(&mut self) {
        self.keeper_noop("abort_stale_cycle");
    }

    pub fn expire_decision(&mut self) {
        self.keeper_noop("expire_decision");
    }

    // Guardian methods (the guardian FCK allows exactly these two).
    pub fn freeze(&mut self) {
        self.only(&self.guardian.clone(), "guardian");
        self.frozen = true;
        emit("frozen", r#"{"by":"guardian"}"#);
    }

    pub fn cancel_keeper_change(&mut self) {
        self.only(&self.guardian.clone(), "guardian");
        emit("keeper_change_cancelled", "{}");
    }

    // Governor method, not reachable from either FCK.
    pub fn unfreeze(&mut self) {
        self.only(&self.governor.clone(), "governor");
        self.frozen = false;
        emit("unfrozen", "{}");
    }

    pub fn selftest(&self) -> SelfTest {
        SelfTest {
            version: STUB_VERSION.to_string(),
            args_hash: self.args_hash.clone(),
            governor: self.governor.clone(),
            keeper: self.keeper.clone(),
            guardian: self.guardian.clone(),
            frozen: self.frozen,
            cycles: self.cycles,
        }
    }
}

impl Vault {
    fn only(&self, role_account: &AccountId, role: &str) {
        require!(env::predecessor_account_id() == *role_account, format!("only {role}"));
    }

    fn keeper_noop(&mut self, method: &str) {
        self.only(&self.keeper.clone(), "keeper");
        emit("keeper_call", &format!(r#"{{"method":"{method}"}}"#));
    }
}
