//! Depositor registration, the NEP-145 surface. Each depositor pays once, in advance, for the
//! entries the vault keeps for it, so open deposits cannot spend the NEAR the vault needs for
//! its own cycles. The vault never sends NEAR: a wrong attachment panics and the runtime
//! hands it back.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken};

use crate::events::emit;
use crate::{Vault, VaultExt};

/// Covers every entry the longest account id can hold at once, 1,165 bytes as
/// `the_fee_covers_every_entry_a_depositor_can_hold` measures, with about 29% to spare.
pub const REGISTRATION_FEE: NearToken = NearToken::from_millinear(15);

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near]
impl Vault {
    /// `registration_only` changes nothing: the fee is fixed, so there is never a surplus.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        require!(
            env::attached_deposit() == REGISTRATION_FEE,
            "attach exactly the registration fee"
        );
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        require!(
            self.registered.insert(account.clone()),
            "already registered"
        );
        emit(
            "storage_registered",
            &format!(r#"{{"account":"{account}"}}"#),
        );
        registered_balance()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered
            .contains(&account_id)
            .then(registered_balance)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: fee(),
            max: Some(fee()),
        }
    }

    /// Nothing is ever available: the whole fee backs entries the vault may still hold.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        require!(
            self.registered.contains(&env::predecessor_account_id()),
            "not registered"
        );
        require!(
            amount.is_none_or(|amount| amount.0 == 0),
            "nothing to withdraw"
        );
        registered_balance()
    }

    /// Permanent, because a claim slot reserved for a transfer still in flight can never be
    /// freed safely: its callback would have to write new storage to record a failure.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let _ = force;
        if !self.is_registered(&env::predecessor_account_id()) {
            return false;
        }
        env::panic_str("registration is permanent")
    }
}

impl Vault {
    pub(crate) fn is_registered(&self, account: &AccountId) -> bool {
        self.registered.contains(account)
    }
}

fn fee() -> U128 {
    U128(REGISTRATION_FEE.as_yoctonear())
}

fn registered_balance() -> StorageBalance {
    StorageBalance {
        total: fee(),
        available: U128(0),
    }
}
