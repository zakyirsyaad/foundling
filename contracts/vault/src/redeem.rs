//! In-kind exit. It needs no price, keeper, or agent, and works while frozen or halted.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PromiseError};

use crate::events::emit;
use crate::math::{mul_div, payout};
use crate::{Token, Vault, VaultExt};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
const ON_XFER_GAS: Gas = Gas::from_tgas(10);
const ENTRY_GAS: Gas = Gas::from_tgas(15);
const TRANSFER_RESULT_MAX_BYTES: usize = 64;

#[near]
impl Vault {
    /// Book and shares are debited before any promise leaves, so a failed transfer
    /// can only ever credit `claimable`, never pay twice.
    #[payable]
    pub fn redeem(&mut self, shares: U128) {
        assert_one_yocto();
        self.require_transfer_gas(2);
        let account = env::predecessor_account_id();
        let held = self.shares.get(&account).copied().unwrap_or(0);
        require!(shares.0 > 0 && shares.0 <= held, "not enough shares");

        let usdc_out = payout(self.usdc_book, shares.0, self.total_shares);
        let wnear_out = payout(self.wnear_book, shares.0, self.total_shares);
        require!(usdc_out > 0 || wnear_out > 0, "nothing to pay");

        let net = self.net_deposit(&account);
        let net_out = mul_div(net, shares.0, held);
        self.net_deposits.insert(account.clone(), net - net_out);
        self.total_net -= net_out;
        self.shares.insert(account.clone(), held - shares.0);
        self.total_shares -= shares.0;
        self.usdc_book -= usdc_out;
        self.wnear_book -= wnear_out;

        emit(
            "redeemed",
            &format!(
                r#"{{"account":"{account}","shares":"{}","usdc":"{usdc_out}","wnear":"{wnear_out}"}}"#,
                shares.0
            ),
        );
        if usdc_out > 0 {
            self.send_token(account.clone(), Token::Usdc, usdc_out);
        }
        if wnear_out > 0 {
            self.send_token(account, Token::Wnear, wnear_out);
        }
    }

    #[payable]
    pub fn withdraw_claimable(&mut self, token: Token) {
        assert_one_yocto();
        self.require_transfer_gas(1);
        let account = env::predecessor_account_id();
        let amount = self.claimable_amount(&account, token);
        require!(amount > 0, "nothing claimable");
        self.claimable.insert((account.clone(), token), 0);
        self.send_token(account, token, amount);
    }

    /// Never panics: a panic here would lose the only record of a failed transfer.
    #[private]
    pub fn on_xfer(&mut self, account: AccountId, token: Token, amount: U128) {
        if !transfer_failed() {
            return;
        }
        let credited = self.claimable_amount(&account, token) + amount.0;
        emit(
            "transfer_failed",
            &format!(r#"{{"account":"{account}","amount":"{}"}}"#, amount.0),
        );
        self.claimable.insert((account, token), credited);
    }
}

impl Vault {
    pub(crate) fn require_transfer_gas(&self, transfers: u64) {
        let per_transfer = FT_TRANSFER_GAS.as_tgas() + ON_XFER_GAS.as_tgas();
        let needed = Gas::from_tgas(ENTRY_GAS.as_tgas() + transfers * per_transfer);
        require!(env::prepaid_gas() >= needed, "LOW_GAS");
    }

    pub(crate) fn claimable_amount(&self, account: &AccountId, token: Token) -> u128 {
        self.claimable
            .get(&(account.clone(), token))
            .copied()
            .unwrap_or(0)
    }

    /// Reserves the claim slot before the promise, so the callback writes no new storage.
    pub(crate) fn send_token(&mut self, account: AccountId, token: Token, amount: u128) {
        let held = self.claimable_amount(&account, token);
        self.claimable.insert((account.clone(), token), held);

        let transfer = env::promise_create(
            self.token_account(token),
            "ft_transfer",
            json!({ "receiver_id": account, "amount": U128(amount) }).to_string(),
            ONE_YOCTO,
            FT_TRANSFER_GAS,
        );
        env::promise_then(
            transfer,
            env::current_account_id(),
            "on_xfer",
            json!({ "account": account, "token": token, "amount": U128(amount) }).to_string(),
            NO_DEPOSIT,
            ON_XFER_GAS,
        );
    }
}

fn transfer_failed() -> bool {
    matches!(
        env::promise_result_checked(0, TRANSFER_RESULT_MAX_BYTES),
        Err(PromiseError::Failed)
    )
}
