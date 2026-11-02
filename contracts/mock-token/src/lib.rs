//! MOCK TESTNET TOKEN. Not USDC and not wNEAR: it has no value and the owner can mint any
//! amount. It stands in for the real tokens where their faucets are slow or scarce, and
//! it answers `ft_metadata`, `storage_deposit`, `ft_transfer` and `ft_transfer_call` the
//! way the vault's setup, selftest and deposit path expect.

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};

const STORAGE_MIN: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(30);
const RESOLVE_RESULT_MAX_BYTES: usize = 64;
const LABEL: &str = "MOCK TESTNET TOKEN";

#[allow(dead_code)]
#[ext_contract(ext_receiver)]
trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128;
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait SelfResolver {
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128;
}

#[near(serializers = [json])]
pub struct Metadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Balances,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockToken {
    owner: AccountId,
    name: String,
    symbol: String,
    decimals: u8,
    total_supply: u128,
    /// Presence means registered, so a zero balance is still a registered account.
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl MockToken {
    #[init]
    pub fn init(owner: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init: only the mock account"
        );
        Self {
            owner,
            name,
            symbol,
            decimals,
            total_supply: 0,
            balances: LookupMap::new(StorageKey::Balances),
        }
    }

    /// The test faucet. It registers the account as a side effect.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
        let held = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, held + amount.0);
        self.total_supply += amount.0;
    }

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit();
        let refund = if self.balances.contains_key(&account) {
            attached
        } else {
            require!(
                attached >= STORAGE_MIN,
                "The attached deposit is less than the minimum storage balance"
            );
            self.balances.insert(account, 0);
            attached.saturating_sub(STORAGE_MIN)
        };
        if !refund.is_zero() {
            let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
        }
        StorageBalance {
            total: U128(STORAGE_MIN.as_yoctonear()),
            available: U128(0),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances
            .contains_key(&account_id)
            .then_some(StorageBalance {
                total: U128(STORAGE_MIN.as_yoctonear()),
                available: U128(0),
            })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN.as_yoctonear()),
            max: Some(U128(STORAGE_MIN.as_yoctonear())),
        }
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let _ = memo;
        self.transfer(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        let _ = memo;
        let receiver_gas = env::prepaid_gas()
            .checked_sub(GAS_FOR_FT_TRANSFER_CALL)
            .unwrap_or_else(|| env::panic_str("More gas is required"));
        let sender_id = env::predecessor_account_id();
        self.transfer(&sender_id, &receiver_id, amount.0);
        let on_transfer = ext_receiver::ext(receiver_id.clone())
            .with_static_gas(receiver_gas)
            .ft_on_transfer(sender_id.clone(), amount, msg);
        let resolve = ext_self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
            .ft_resolve_transfer(sender_id, receiver_id, amount);
        PromiseOrValue::Promise(on_transfer.then(resolve))
    }

    /// Whatever the receiver does not use goes back. A receiver that panics, or answers
    /// something that is not a number, refunds the whole amount.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, RESOLVE_RESULT_MAX_BYTES) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map_or(amount.0, |unused| unused.0.min(amount.0)),
            Err(_) => amount.0,
        };
        if unused == 0 {
            return amount;
        }
        let held = self.balances.get(&receiver_id).copied().unwrap_or(0);
        let refund = unused.min(held);
        if refund > 0 {
            self.balances.insert(receiver_id, held - refund);
            let sender_held = self.balances.get(&sender_id).copied().unwrap_or(0);
            self.balances.insert(sender_id, sender_held + refund);
        }
        U128(amount.0 - refund)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_metadata(&self) -> Metadata {
        Metadata {
            spec: "ft-1.0.0".to_string(),
            name: format!("{LABEL}: {}", self.name),
            symbol: self.symbol.clone(),
            icon: None,
            reference: Some("mock token for the Foundling testnet, it has no value".to_string()),
            reference_hash: None,
            decimals: self.decimals,
        }
    }
}

impl MockToken {
    fn transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        require!(
            sender != receiver,
            "Sender and receiver should be different"
        );
        require!(amount > 0, "The amount should be a positive number");
        let Some(&sender_held) = self.balances.get(sender) else {
            env::panic_str("The sender is not registered");
        };
        let Some(&receiver_held) = self.balances.get(receiver) else {
            env::panic_str(&format!("The account {receiver} is not registered"));
        };
        require!(
            sender_held >= amount,
            "The account doesn't have enough balance"
        );
        self.balances.insert(sender.clone(), sender_held - amount);
        self.balances
            .insert(receiver.clone(), receiver_held + amount);
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    use super::*;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn refunded_to(who: &str) -> Vec<NearToken> {
        get_created_receipts()
            .into_iter()
            .filter(|receipt| receipt.receiver_id == account(who))
            .flat_map(|receipt| receipt.actions)
            .filter_map(|action| match action {
                MockAction::Transfer { deposit, .. } => Some(deposit),
                _ => None,
            })
            .collect()
    }

    fn call(predecessor: &str, deposit: NearToken) {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(account("token.testnet"))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(100));
        testing_env!(context.build());
    }

    fn token() -> MockToken {
        call("token.testnet", NearToken::from_yoctonear(0));
        let mut token = MockToken::init(
            account("owner.testnet"),
            "USDC".to_string(),
            "mUSDC".to_string(),
            6,
        );
        call("owner.testnet", NearToken::from_yoctonear(0));
        token.mint(account("alice.testnet"), U128(1_000));
        token.mint(account("bob.testnet"), U128(0));
        token
    }

    fn one_yocto() -> NearToken {
        NearToken::from_yoctonear(1)
    }

    #[test]
    fn the_metadata_says_it_is_a_mock() {
        let token = token();

        let metadata = token.ft_metadata();

        assert!(metadata.name.starts_with("MOCK TESTNET TOKEN"));
        assert_eq!(metadata.decimals, 6);
    }

    #[test]
    fn a_transfer_moves_the_balance() {
        let mut token = token();
        call("alice.testnet", one_yocto());

        token.ft_transfer(account("bob.testnet"), U128(400), None);

        assert_eq!(token.ft_balance_of(account("alice.testnet")), U128(600));
        assert_eq!(token.ft_balance_of(account("bob.testnet")), U128(400));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn a_transfer_to_an_unregistered_account_panics() {
        let mut token = token();
        call("alice.testnet", one_yocto());

        token.ft_transfer(account("carol.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn a_transfer_needs_one_yocto() {
        let mut token = token();
        call("alice.testnet", NearToken::from_yoctonear(0));

        token.ft_transfer(account("bob.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_mints() {
        let mut token = token();
        call("alice.testnet", NearToken::from_yoctonear(0));

        token.mint(account("alice.testnet"), U128(1));
    }

    #[test]
    fn storage_deposit_registers_the_account() {
        let mut token = token();
        call("carol.testnet", STORAGE_MIN);

        token.storage_deposit(None, Some(true));

        assert!(token.storage_balance_of(account("carol.testnet")).is_some());
        assert!(token.storage_balance_of(account("dave.testnet")).is_none());
    }

    #[test]
    fn storage_deposit_refunds_what_exceeds_the_minimum() {
        let mut token = token();
        let extra = NearToken::from_yoctonear(5);
        call("carol.testnet", STORAGE_MIN.saturating_add(extra));

        token.storage_deposit(None, Some(true));

        assert_eq!(refunded_to("carol.testnet"), vec![extra]);
    }

    #[test]
    fn storage_deposit_of_exactly_the_minimum_refunds_nothing() {
        let mut token = token();
        call("carol.testnet", STORAGE_MIN);

        token.storage_deposit(None, Some(true));

        assert!(refunded_to("carol.testnet").is_empty());
    }

    #[test]
    fn storage_deposit_for_a_registered_account_refunds_everything() {
        let mut token = token();
        let attached = NearToken::from_yoctonear(7);
        call("alice.testnet", attached);

        token.storage_deposit(Some(account("alice.testnet")), None);

        assert_eq!(refunded_to("alice.testnet"), vec![attached]);
    }

    #[test]
    #[should_panic(expected = "less than the minimum storage balance")]
    fn storage_deposit_below_the_minimum_panics() {
        let mut token = token();
        call("carol.testnet", NearToken::from_yoctonear(1));

        token.storage_deposit(None, Some(true));
    }

    fn resolve_with(token: &mut MockToken, reply: PromiseResult) -> U128 {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(account("token.testnet"))
            .predecessor_account_id(account("token.testnet"));
        testing_env!(
            context.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![reply]
        );
        token.ft_resolve_transfer(account("alice.testnet"), account("bob.testnet"), U128(400))
    }

    #[test]
    fn a_receiver_that_keeps_everything_keeps_it() {
        let mut token = token();
        call("alice.testnet", one_yocto());
        token.ft_transfer(account("bob.testnet"), U128(400), None);

        let used = resolve_with(&mut token, PromiseResult::Successful(b"\"0\"".to_vec()));

        assert_eq!(used, U128(400));
        assert_eq!(token.ft_balance_of(account("bob.testnet")), U128(400));
    }

    #[test]
    fn a_receiver_that_returns_the_amount_refunds_it() {
        let mut token = token();
        call("alice.testnet", one_yocto());
        token.ft_transfer(account("bob.testnet"), U128(400), None);

        let used = resolve_with(&mut token, PromiseResult::Successful(b"\"400\"".to_vec()));

        assert_eq!(used, U128(0));
        assert_eq!(token.ft_balance_of(account("alice.testnet")), U128(1_000));
        assert_eq!(token.ft_balance_of(account("bob.testnet")), U128(0));
    }

    #[test]
    fn a_receiver_that_panics_refunds_everything() {
        let mut token = token();
        call("alice.testnet", one_yocto());
        token.ft_transfer(account("bob.testnet"), U128(400), None);

        let used = resolve_with(&mut token, PromiseResult::Failed);

        assert_eq!(used, U128(0));
        assert_eq!(token.ft_balance_of(account("alice.testnet")), U128(1_000));
    }
}
