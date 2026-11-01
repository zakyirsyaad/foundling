//! A labelled test token with six decimals, the shape of native USDC on mainnet. It has no
//! value: only its owner mints, and it exists to run the vault on testnet at the real scale.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

const DECIMALS: u8 = 6;
const NAME: &str = "Foundling test USD (mock, no value)";
const SYMBOL: &str = "mUSDC6";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockToken {
    owner: AccountId,
    token: FungibleToken,
}

#[near]
impl MockToken {
    #[init]
    pub fn init(owner: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init: only the mock account"
        );
        Self {
            owner,
            token: FungibleToken::new(StorageKey::Accounts),
        }
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
    }
}

#[near]
impl FungibleTokenCore for MockToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for MockToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: NAME.to_string(),
            symbol: SYMBOL.to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    use super::*;

    const ONE_USDC: u128 = 1_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn token_account() -> AccountId {
        account("token.testnet")
    }

    fn owner() -> AccountId {
        account("owner.testnet")
    }

    fn alice() -> AccountId {
        account("alice.testnet")
    }

    fn call_from(caller: AccountId) {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(token_account())
            .predecessor_account_id(caller);
        testing_env!(context.build());
    }

    fn token() -> MockToken {
        call_from(token_account());
        let contract = MockToken::init(owner());
        call_from(owner());
        contract
    }

    #[test]
    fn the_metadata_has_the_decimals_of_mainnet_usdc() {
        assert_eq!(token().ft_metadata().decimals, 6);
    }

    #[test]
    fn the_name_says_it_is_a_mock() {
        assert!(token().ft_metadata().name.contains("mock"));
    }

    #[test]
    fn the_owner_mints() {
        let mut contract = token();

        contract.mint(alice(), U128(ONE_USDC));

        assert_eq!(contract.ft_balance_of(alice()), U128(ONE_USDC));
        assert_eq!(contract.ft_total_supply(), U128(ONE_USDC));
    }

    #[test]
    fn a_second_mint_adds_up() {
        let mut contract = token();

        contract.mint(alice(), U128(ONE_USDC));
        contract.mint(alice(), U128(ONE_USDC));

        assert_eq!(contract.ft_balance_of(alice()), U128(2 * ONE_USDC));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn nobody_else_mints() {
        let mut contract = token();
        call_from(alice());

        contract.mint(alice(), U128(ONE_USDC));
    }

    #[test]
    #[should_panic(expected = "init: only the mock account")]
    fn nobody_else_initializes() {
        call_from(alice());

        MockToken::init(alice());
    }
}
