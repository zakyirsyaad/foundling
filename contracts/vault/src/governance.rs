//! Roles after `init`. Nothing here can loosen a limit or move funds.

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
        emit("policy_tightened", "{}");
    }

    pub fn add_depositor(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        emit("depositor_added", &format!(r#"{{"account":"{account}"}}"#));
        self.allowlist.insert(account);
    }

    pub fn schedule_keeper_change(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        self.keeper_change = Some(self.role_change(account));
        emit("keeper_change_scheduled", "{}");
    }

    pub fn schedule_guardian_change(&mut self, account: AccountId) {
        self.only(&self.roles.governor.clone(), "governor");
        self.guardian_change = Some(self.role_change(account));
        emit("guardian_change_scheduled", "{}");
    }

    pub fn cancel_keeper_change(&mut self) {
        self.only(&self.roles.guardian.clone(), "guardian");
        self.keeper_change = None;
        emit("keeper_change_cancelled", "{}");
    }

    pub fn apply_keeper_change(&mut self) {
        self.roles.keeper = ready_account(self.keeper_change.take());
        emit("keeper_change_applied", "{}");
    }

    pub fn apply_guardian_change(&mut self) {
        self.roles.guardian = ready_account(self.guardian_change.take());
        emit("guardian_change_applied", "{}");
    }
}

impl Vault {
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

fn ready_account(change: Option<RoleChange>) -> AccountId {
    let Some(change) = change else {
        env::panic_str("no change scheduled");
    };
    require!(now_seconds() >= change.apply_after, "TIMELOCK");
    change.account
}
