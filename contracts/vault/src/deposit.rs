//! The deposit queue. Shares are minted only while the vault is flat, so no price is needed.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::events::emit;
use crate::math::shares_for_deposit;
use crate::{Token, Vault, VaultExt};

const DEPOSIT_MSG: &str = "deposit";

#[near]
impl Vault {
    /// Returns the unused amount, so every refusal hands the whole deposit back.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if !self.accepts_deposit(&sender_id, amount.0, &msg) {
            return amount;
        }
        let queued = self.pending.get(&sender_id).copied().unwrap_or(0);
        let net = self.net_deposit(&sender_id);
        self.pending.insert(sender_id.clone(), queued + amount.0);
        self.net_deposits.insert(sender_id.clone(), net + amount.0);
        self.total_net += amount.0;
        emit(
            "deposit_queued",
            &format!(r#"{{"account":"{sender_id}","amount":"{}"}}"#, amount.0),
        );
        U128(0)
    }

    #[payable]
    pub fn cancel_deposit(&mut self) {
        assert_one_yocto();
        self.require_transfer_gas(1);
        let account = env::predecessor_account_id();
        let Some(amount) = self.pending.remove(&account) else {
            env::panic_str("nothing pending");
        };
        let net = self.net_deposit(&account);
        self.net_deposits.insert(account.clone(), net - amount);
        self.total_net -= amount;
        self.send_token(account, Token::Usdc, amount);
    }
}

impl Vault {
    fn accepts_deposit(&self, sender: &AccountId, amount: u128, msg: &str) -> bool {
        env::predecessor_account_id() == self.assets.usdc
            && msg == DEPOSIT_MSG
            && !self.frozen
            && !self.halted
            && self.is_setup_done()
            && self.selftest_passed
            && self.has_near_floor(0)
            && self.allowlist.contains(sender)
            && amount >= self.policy.min_deposit.0
            && self.net_deposit(sender) + amount <= self.policy.per_user_cap.0
            && self.total_net + amount <= self.policy.tvl_cap.0
    }

    /// Book NAV is the USDC book here: wNEAR at or under dust is valued at zero.
    pub(crate) fn mint_pending(&mut self) {
        if self.wnear_book > self.policy.dust_wnear.0 {
            return;
        }
        let limit = self.policy.max_mint_per_cycle as usize;
        let queue: Vec<(AccountId, u128)> = self
            .pending
            .iter()
            .take(limit)
            .map(|(account, amount)| (account.clone(), *amount))
            .collect();
        for (account, amount) in queue {
            self.mint(account, amount);
        }
    }

    fn mint(&mut self, account: AccountId, amount: u128) {
        let minted = shares_for_deposit(amount, self.total_shares, self.usdc_book);
        if minted == 0 {
            return;
        }
        self.pending.remove(&account);
        let held = self.shares.get(&account).copied().unwrap_or(0);
        self.shares.insert(account.clone(), held + minted);
        self.total_shares += minted;
        self.usdc_book += amount;
        emit(
            "minted",
            &format!(r#"{{"account":"{account}","shares":"{minted}","amount":"{amount}"}}"#),
        );
    }
}
