//! Roles after `init`. Nothing here can loosen a limit or move funds.

use near_sdk::serde_json;
use near_sdk::{env, near, require, AccountId};

use crate::events::emit;
use crate::policy::PolicyChange;
use crate::{now_seconds, Vault, VaultExt};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoleChange {
    pub account: AccountId,
    pub apply_after: u64,
}

#[near]
impl Vault {
    pub fn freeze(&mut self) {
        self.only(&self.roles.guardian.clone(), "guardian");
        self.frozen = true;
        emit("frozen", "{}");
    }

    pub fn unfreeze(&mut self) {
        self.only(&self.roles.governor.clone(), "governor");
        self.frozen = false;
        emit("unfrozen", "{}");
    }

    pub fn clear_halt(&mut self) {
        self.only(&self.roles.governor.clone(), "governor");
        self.halted = false;
        emit("halt_cleared", "{}");
    }

    pub fn tighten_policy(&mut self, change: PolicyChange) {
        self.only(&self.roles.governor.clone(), "governor");
        match self.policy.tightened(&self.initial_policy, &change) {
            Ok(policy) => self.policy = policy,
            Err(code) => env::panic_str(code),
        }
        emit(
            "policy_tightened",
            &serde_json::to_string(&change).unwrap_or_default(),
        );
    }

    pub fn add_depositor(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        self.require_near_floor(0);
        emit("depositor_added", &format!(r#"{{"account":"{account}"}}"#));
        self.allowlist.insert(account);
    }

    pub fn schedule_keeper_change(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        self.require_separate_roles(&account, &self.roles.guardian);
        let change = self.role_change(account);
        emit("keeper_change_scheduled", &change_data(&change));
        self.keeper_change = Some(change);
    }

    pub fn schedule_guardian_change(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        self.require_separate_roles(&self.roles.keeper, &account);
        let change = self.role_change(account);
        emit("guardian_change_scheduled", &change_data(&change));
        self.guardian_change = Some(change);
    }

    pub fn cancel_keeper_change(&mut self) {
        self.only(&self.roles.guardian.clone(), "guardian");
        self.keeper_change = None;
        emit("keeper_change_cancelled", "{}");
    }

    pub fn apply_keeper_change(&mut self) {
        let keeper = ready_account(self.keeper_change.take());
        self.require_separate_roles(&keeper, &self.roles.guardian);
        emit("keeper_change_applied", &account_data(&keeper));
        self.roles.keeper = keeper;
    }

    pub fn apply_guardian_change(&mut self) {
        let guardian = ready_account(self.guardian_change.take());
        self.require_separate_roles(&self.roles.keeper, &guardian);
        emit("guardian_change_applied", &account_data(&guardian));
        self.roles.guardian = guardian;
    }
}

impl Vault {
    /// The two `init` guards, checked again because a rotation can meet the other role.
    fn require_separate_roles(&self, keeper: &AccountId, guardian: &AccountId) {
        require!(
            *keeper != self.vault_id,
            "keeper must differ from the vault"
        );
        require!(keeper != guardian, "keeper must differ from the guardian");
    }

    fn only(&self, role_account: &AccountId, role: &str) {
        require!(
            env::predecessor_account_id() == *role_account,
            format!("only {role}")
        );
    }

    fn role_change(&self, account: AccountId) -> RoleChange {
        RoleChange {
            account,
            apply_after: now_seconds() + self.policy.timelock,
        }
    }
}

fn change_data(change: &RoleChange) -> String {
    format!(
        r#"{{"account":"{}","apply_after":{}}}"#,
        change.account, change.apply_after
    )
}

fn account_data(account: &AccountId) -> String {
    format!(r#"{{"account":"{account}"}}"#)
}

fn ready_account(change: Option<RoleChange>) -> AccountId {
    let Some(change) = change else {
        env::panic_str("no change scheduled");
    };
    require!(now_seconds() >= change.apply_after, "TIMELOCK");
    change.account
}
