//! A labelled stand-in for Ref with fault switches, for testnet only. Real Ref cannot be
//! made to fail on demand, and the vault's recovery path has to be proven on chain.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};

const PRICE_ONE: u128 = 100_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
const ON_WITHDRAW_GAS: Gas = Gas::from_tgas(10);
const ON_LATE_REPLY_GAS: Gas = Gas::from_tgas(5);
const MAX_RESULT_BYTES: usize = 64;
const GARBAGE: &[u8] = br#""not a number""#;

#[allow(dead_code)]
#[ext_contract(ext_token)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128);
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fault {
    #[default]
    None,
    /// `ft_on_transfer` keeps half and refunds the rest.
    DepositPartial,
    /// The swap happens, the answer cannot be read.
    SwapGarbage,
    /// The swap does not happen, the answer cannot be read.
    SwapGarbageNotApplied,
    /// Nothing is sent and the answer is `"0"`, as when Ref's `ft_transfer` fails.
    WithdrawZero,
    /// Half is sent and the answer says half.
    WithdrawPartial,
    /// Everything is sent, the answer cannot be read.
    WithdrawGarbage,
    /// `get_deposits` panics until the owner clears it. The others fire once.
    ProbeFails,
    /// The deposit lands, the answer comes only when the yield times out.
    DepositHang,
    /// The swap happens, the answer comes only when the yield times out.
    SwapHang,
    /// The swap does not happen, the answer comes only when the yield times out.
    SwapHangNotApplied,
    /// Nothing is sent, and `"0"` comes only when the yield times out.
    WithdrawHang,
    /// Everything is sent, the answer comes only when the yield times out.
    WithdrawHangSent,
}

#[near(serializers = [json])]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
}

#[near(serializers = [json])]
pub struct PoolInfo {
    pub pool_kind: String,
    pub token_account_ids: Vec<AccountId>,
    pub amounts: Vec<U128>,
    pub total_fee: u32,
    pub shares_total_supply: U128,
    pub amp: u64,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Deposits,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockRef {
    owner: AccountId,
    usdc: AccountId,
    wnear: AccountId,
    pool_id: u64,
    total_fee: u32,
    /// wNEAR in USDC with eight decimals.
    price: u128,
    /// 10^(wNEAR decimals - USDC decimals).
    decimal_scale: u128,
    fault: Fault,
    deposits: LookupMap<(AccountId, AccountId), u128>,
}

#[near]
impl MockRef {
    #[init]
    pub fn init(
        owner: AccountId,
        usdc: AccountId,
        wnear: AccountId,
        pool_id: u64,
        total_fee: u32,
        price: U128,
        decimal_scale: U128,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init: only the mock account"
        );
        Self {
            owner,
            usdc,
            wnear,
            pool_id,
            total_fee,
            price: price.0,
            decimal_scale: decimal_scale.0,
            fault: Fault::None,
            deposits: LookupMap::new(StorageKey::Deposits),
        }
    }

    pub fn set_fault(&mut self, fault: Fault) {
        self.require_owner();
        self.fault = fault;
    }

    pub fn set_price(&mut self, price: U128) {
        self.require_owner();
        self.price = price.0;
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        require!(
            token == self.usdc || token == self.wnear,
            "E12: token not whitelisted"
        );
        let refund = if self.take_fault(Fault::DepositPartial) {
            amount.0 / 2
        } else {
            0
        };
        self.credit(&sender_id, &token, amount.0 - refund);
        if self.take_fault(Fault::DepositHang) {
            return PromiseOrValue::Promise(late_reply(amount_reply(refund, false)));
        }
        PromiseOrValue::Value(U128(refund))
    }

    #[payable]
    pub fn swap(&mut self, actions: Vec<SwapAction>) {
        require!(actions.len() == 1, "one action only");
        let action = &actions[0];
        require!(action.pool_id == self.pool_id, "E404: pool not found");
        let amount_out = self.quote(&action.token_in, action.amount_in.0);
        require!(amount_out >= action.min_amount_out.0, "E68: slippage error");
        let hung_unapplied = self.take_fault(Fault::SwapHangNotApplied);
        let hung = hung_unapplied || self.take_fault(Fault::SwapHang);
        let unreadable_unapplied = self.take_fault(Fault::SwapGarbageNotApplied);
        let garbage = unreadable_unapplied || self.take_fault(Fault::SwapGarbage);
        if !hung_unapplied && !unreadable_unapplied {
            let sender = env::predecessor_account_id();
            self.debit(&sender, &action.token_in, action.amount_in.0);
            self.credit(&sender, &action.token_out, amount_out);
        }
        if hung {
            drop(late_reply(amount_reply(amount_out, garbage)));
            return;
        }
        env::value_return(amount_reply(amount_out, garbage));
    }

    #[payable]
    pub fn withdraw(
        &mut self,
        token_id: AccountId,
        amount: U128,
        unregister: Option<bool>,
        skip_unwrap_near: Option<bool>,
    ) -> PromiseOrValue<U128> {
        let _ = (unregister, skip_unwrap_near);
        if self.take_fault(Fault::WithdrawZero) {
            return PromiseOrValue::Value(U128(0));
        }
        if self.take_fault(Fault::WithdrawHang) {
            return PromiseOrValue::Promise(late_reply(amount_reply(0, false)));
        }
        let sent = if self.take_fault(Fault::WithdrawPartial) {
            amount.0 / 2
        } else {
            amount.0
        };
        let garbage = self.take_fault(Fault::WithdrawGarbage);
        let sender = env::predecessor_account_id();
        self.debit(&sender, &token_id, sent);
        let transfer = ext_token::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(sender.clone(), U128(sent));
        if self.take_fault(Fault::WithdrawHangSent) {
            drop(transfer);
            return PromiseOrValue::Promise(late_reply(amount_reply(sent, false)));
        }
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(ON_WITHDRAW_GAS)
            .on_withdraw(sender, token_id, U128(sent), garbage);
        PromiseOrValue::Promise(transfer.then(callback))
    }

    /// Ref credits the balance back when its `ft_transfer` fails and answers `"0"`.
    #[private]
    pub fn on_withdraw(
        &mut self,
        sender: AccountId,
        token_id: AccountId,
        amount: U128,
        garbage: bool,
    ) {
        if env::promise_result_checked(0, MAX_RESULT_BYTES).is_err() {
            self.credit(&sender, &token_id, amount.0);
            env::value_return(amount_reply(0, false));
            return;
        }
        env::value_return(amount_reply(amount.0, garbage));
    }

    /// Where a hung call finally answers. The yield only ever times out here.
    #[private]
    pub fn on_late_reply(&self, reply: String) {
        env::value_return(reply.as_bytes());
    }

    /// Real Ref lets any account credit another one this way, so a vault's Ref balance
    /// can grow without the vault doing anything.
    #[payable]
    pub fn mft_transfer(
        &mut self,
        token_id: String,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) {
        let _ = memo;
        let token: AccountId = token_id
            .parse()
            .unwrap_or_else(|_| env::panic_str("bad token"));
        self.debit(&env::predecessor_account_id(), &token, amount.0);
        self.credit(&receiver_id, &token, amount.0);
    }

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) {
        let _ = (account_id, registration_only);
    }

    #[payable]
    pub fn register_tokens(&mut self, token_ids: Vec<AccountId>) {
        let _ = token_ids;
    }

    pub fn get_deposits(&self, account_id: AccountId) -> BTreeMap<AccountId, U128> {
        require!(self.fault != Fault::ProbeFails, "probe fault");
        [&self.usdc, &self.wnear]
            .into_iter()
            .map(|token| (token.clone(), U128(self.balance(&account_id, token))))
            .collect()
    }

    pub fn get_pool(&self, pool_id: u64) -> PoolInfo {
        require!(pool_id == self.pool_id, "E404: pool not found");
        PoolInfo {
            pool_kind: "SIMPLE_POOL".to_string(),
            token_account_ids: vec![self.usdc.clone(), self.wnear.clone()],
            amounts: vec![U128(0), U128(0)],
            total_fee: self.total_fee,
            shares_total_supply: U128(0),
            amp: 0,
        }
    }
}

impl MockRef {
    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
    }

    fn take_fault(&mut self, fault: Fault) -> bool {
        let matched = self.fault == fault;
        if matched {
            self.fault = Fault::None;
        }
        matched
    }

    fn quote(&self, token_in: &AccountId, amount_in: u128) -> u128 {
        if *token_in == self.usdc {
            amount_in * self.decimal_scale * PRICE_ONE / self.price
        } else {
            amount_in * self.price / PRICE_ONE / self.decimal_scale
        }
    }

    fn balance(&self, account: &AccountId, token: &AccountId) -> u128 {
        let key = (account.clone(), token.clone());
        self.deposits.get(&key).copied().unwrap_or(0)
    }

    fn credit(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        let held = self.balance(account, token);
        self.deposits
            .insert((account.clone(), token.clone()), held + amount);
    }

    fn debit(&mut self, account: &AccountId, token: &AccountId, amount: u128) {
        let held = self.balance(account, token);
        require!(held >= amount, "E22: not enough tokens in deposit");
        self.deposits
            .insert((account.clone(), token.clone()), held - amount);
    }
}

/// An answer held back for about 200 blocks, so the caller's step outlives `stuck_after`.
fn late_reply(reply: Vec<u8>) -> Promise {
    let text = String::from_utf8_lossy(&reply);
    let args = json!({ "reply": text }).to_string();
    let (promise, _) = Promise::new_yield("on_late_reply", args, ON_LATE_REPLY_GAS, GasWeight(0));
    promise.as_return()
}

fn amount_reply(amount: u128, garbage: bool) -> Vec<u8> {
    if garbage {
        return GARBAGE.to_vec();
    }
    format!("\"{amount}\"").into_bytes()
}

#[cfg(test)]
mod tests {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{serde_json, test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

    use super::*;

    const PRICE: u128 = 200_000_000;
    const UNIT: u128 = 1_000_000_000_000_000_000_000_000;
    const POOL: u64 = 1103;
    const MAINNET_SCALE: u128 = 1_000_000_000_000_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn owner() -> AccountId {
        account("owner.testnet")
    }

    fn usdc() -> AccountId {
        account("usdc.testnet")
    }

    fn wnear() -> AccountId {
        account("wrap.testnet")
    }

    fn vault() -> AccountId {
        account("vault.testnet")
    }

    fn mock_ref() -> AccountId {
        account("ref.testnet")
    }

    fn call_from(caller: AccountId) {
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(mock_ref())
            .predecessor_account_id(caller);
        testing_env!(context.build());
    }

    fn set_up() -> MockRef {
        call_from(mock_ref());
        let contract = MockRef::init(owner(), usdc(), wnear(), POOL, 30, U128(PRICE), U128(1));
        call_from(owner());
        contract
    }

    fn funded(amount: u128) -> MockRef {
        let mut contract = set_up();
        let _ = deposit(&mut contract, amount);
        contract
    }

    fn deposit(contract: &mut MockRef, amount: u128) -> PromiseOrValue<U128> {
        call_from(usdc());
        contract.ft_on_transfer(vault(), U128(amount), String::new())
    }

    fn refund(contract: &mut MockRef, amount: u128) -> u128 {
        match deposit(contract, amount) {
            PromiseOrValue::Value(unused) => unused.0,
            PromiseOrValue::Promise(_) => panic!("the deposit hung"),
        }
    }

    fn set_fault(contract: &mut MockRef, fault: Fault) {
        call_from(owner());
        contract.set_fault(fault);
    }

    fn balances(contract: &MockRef) -> (u128, u128) {
        let deposits = contract.get_deposits(vault());
        (deposits[&usdc()].0, deposits[&wnear()].0)
    }

    fn buy(contract: &mut MockRef, amount: u128, minimum: u128) {
        call_from(vault());
        contract.swap(vec![SwapAction {
            pool_id: POOL,
            token_in: usdc(),
            token_out: wnear(),
            amount_in: U128(amount),
            min_amount_out: U128(minimum),
        }]);
    }

    fn withdraw_usdc(contract: &mut MockRef, amount: u128) -> PromiseOrValue<U128> {
        call_from(vault());
        contract.withdraw(usdc(), U128(amount), None, Some(true))
    }

    fn sent_nothing(answer: PromiseOrValue<U128>) -> bool {
        matches!(answer, PromiseOrValue::Value(U128(0)))
    }

    #[test]
    #[should_panic(expected = "init: only the mock account")]
    fn a_stranger_cannot_initialise_it() {
        call_from(account("stranger.testnet"));

        MockRef::init(owner(), usdc(), wnear(), POOL, 30, U128(PRICE), U128(1));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_a_fault() {
        let mut contract = set_up();
        call_from(vault());

        contract.set_fault(Fault::WithdrawZero);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_the_price() {
        let mut contract = set_up();
        call_from(vault());

        contract.set_price(U128(1));
    }

    #[test]
    fn a_transfer_credits_the_sender() {
        let mut contract = set_up();

        assert_eq!(refund(&mut contract, 5 * UNIT), 0);

        assert_eq!(balances(&contract), (5 * UNIT, 0));
    }

    #[test]
    #[should_panic(expected = "E12: token not whitelisted")]
    fn another_token_is_refused() {
        let mut contract = set_up();
        call_from(account("other.testnet"));

        let _ = contract.ft_on_transfer(vault(), U128(1), String::new());
    }

    #[test]
    fn deposits_list_both_tokens_with_zero_entries_like_ref() {
        let contract = set_up();

        let deposits = serde_json::to_value(contract.get_deposits(vault())).unwrap();

        assert_eq!(deposits[usdc().as_str()], "0");
        assert_eq!(deposits[wnear().as_str()], "0");
    }

    #[test]
    fn the_pool_answers_in_the_shape_selftest_reads() {
        let contract = set_up();

        let pool = contract.get_pool(POOL);

        assert_eq!(pool.token_account_ids, vec![usdc(), wnear()]);
        assert_eq!(pool.total_fee, 30);
    }

    #[test]
    fn a_buy_moves_the_balance_at_the_price() {
        let mut contract = funded(2 * UNIT);

        buy(&mut contract, 2 * UNIT, 1);

        assert_eq!(balances(&contract), (0, UNIT));
    }

    fn real_scale() -> MockRef {
        call_from(mock_ref());
        let contract = MockRef::init(
            owner(),
            usdc(),
            wnear(),
            POOL,
            30,
            U128(PRICE),
            U128(MAINNET_SCALE),
        );
        call_from(owner());
        contract
    }

    #[test]
    fn a_buy_bridges_the_decimals_of_the_two_tokens() {
        let contract = real_scale();

        // Two USDC at 6 decimals buy one wNEAR at 24, at a price of 2.
        assert_eq!(contract.quote(&usdc(), 2_000_000), UNIT);
    }

    #[test]
    fn a_hung_deposit_still_lands() {
        let mut contract = set_up();
        set_fault(&mut contract, Fault::DepositHang);

        let answer = deposit(&mut contract, UNIT);

        assert!(matches!(answer, PromiseOrValue::Promise(_)));
        assert_eq!(balances(&contract), (UNIT, 0));
    }

    #[test]
    fn a_hung_swap_still_moves_the_balance() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::SwapHang);

        buy(&mut contract, 2 * UNIT, 1);

        assert_eq!(balances(&contract), (0, UNIT));
    }

    #[test]
    fn a_hung_swap_can_stay_unapplied() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::SwapHangNotApplied);

        buy(&mut contract, 2 * UNIT, 1);

        assert_eq!(balances(&contract), (2 * UNIT, 0));
    }

    #[test]
    fn a_hung_withdraw_sends_nothing() {
        let mut contract = funded(UNIT);
        set_fault(&mut contract, Fault::WithdrawHang);

        let answer = withdraw_usdc(&mut contract, UNIT);

        assert!(matches!(answer, PromiseOrValue::Promise(_)));
        assert_eq!(balances(&contract), (UNIT, 0));
    }

    #[test]
    fn a_hung_withdraw_can_still_send() {
        let mut contract = funded(UNIT);
        set_fault(&mut contract, Fault::WithdrawHangSent);

        let _ = withdraw_usdc(&mut contract, UNIT);

        assert_eq!(balances(&contract), (0, 0));
    }

    #[test]
    fn a_hang_fires_once() {
        let mut contract = set_up();
        set_fault(&mut contract, Fault::DepositHang);
        let _ = deposit(&mut contract, UNIT);

        assert_eq!(refund(&mut contract, UNIT), 0);
    }

    #[test]
    fn a_sell_bridges_the_decimals_of_the_two_tokens() {
        let contract = real_scale();

        assert_eq!(contract.quote(&wnear(), UNIT), 2_000_000);
    }

    #[test]
    fn a_sell_uses_the_same_price() {
        let mut contract = funded(2 * UNIT);
        buy(&mut contract, 2 * UNIT, 1);
        call_from(vault());

        contract.swap(vec![SwapAction {
            pool_id: POOL,
            token_in: wnear(),
            token_out: usdc(),
            amount_in: U128(UNIT),
            min_amount_out: U128(1),
        }]);

        assert_eq!(balances(&contract), (2 * UNIT, 0));
    }

    #[test]
    #[should_panic(expected = "E68: slippage error")]
    fn a_swap_under_its_minimum_fails_like_ref() {
        let mut contract = funded(2 * UNIT);

        buy(&mut contract, 2 * UNIT, UNIT + 1);
    }

    #[test]
    #[should_panic(expected = "E22: not enough tokens in deposit")]
    fn a_swap_above_the_balance_fails() {
        let mut contract = funded(UNIT);

        buy(&mut contract, 2 * UNIT, 1);
    }

    #[test]
    #[should_panic(expected = "E404: pool not found")]
    fn another_pool_fails() {
        let mut contract = funded(UNIT);
        call_from(vault());

        contract.swap(vec![SwapAction {
            pool_id: POOL + 1,
            token_in: usdc(),
            token_out: wnear(),
            amount_in: U128(UNIT),
            min_amount_out: U128(1),
        }]);
    }

    #[test]
    fn a_partial_deposit_refunds_half_once() {
        let mut contract = set_up();
        set_fault(&mut contract, Fault::DepositPartial);

        assert_eq!(refund(&mut contract, 4 * UNIT), 2 * UNIT);
        assert_eq!(balances(&contract), (2 * UNIT, 0));

        assert_eq!(refund(&mut contract, UNIT), 0);
        assert_eq!(balances(&contract), (3 * UNIT, 0));
    }

    #[test]
    fn a_garbage_swap_still_moves_the_balance() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::SwapGarbage);

        buy(&mut contract, 2 * UNIT, 1);

        assert_eq!(balances(&contract), (0, UNIT));
    }

    #[test]
    fn an_unapplied_garbage_swap_moves_nothing() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::SwapGarbageNotApplied);

        buy(&mut contract, 2 * UNIT, 1);

        assert_eq!(balances(&contract), (2 * UNIT, 0));
    }

    #[test]
    fn a_zero_withdraw_sends_nothing_once() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::WithdrawZero);

        assert!(sent_nothing(withdraw_usdc(&mut contract, 2 * UNIT)));
        assert_eq!(balances(&contract), (2 * UNIT, 0));

        assert!(!sent_nothing(withdraw_usdc(&mut contract, 2 * UNIT)));
        assert_eq!(balances(&contract), (0, 0));
    }

    #[test]
    fn a_partial_withdraw_sends_half() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::WithdrawPartial);

        let _ = withdraw_usdc(&mut contract, 2 * UNIT);

        assert_eq!(balances(&contract), (UNIT, 0));
    }

    #[test]
    fn a_garbage_withdraw_sends_everything() {
        let mut contract = funded(2 * UNIT);
        set_fault(&mut contract, Fault::WithdrawGarbage);

        let _ = withdraw_usdc(&mut contract, 2 * UNIT);

        assert_eq!(balances(&contract), (0, 0));
    }

    #[test]
    fn anyone_can_credit_another_account_like_ref() {
        let mut contract = funded(2 * UNIT);
        let stranger = account("stranger.testnet");
        call_from(vault());

        contract.mft_transfer(usdc().to_string(), stranger.clone(), U128(UNIT), None);

        assert_eq!(contract.get_deposits(stranger)[&usdc()], U128(UNIT));
        assert_eq!(balances(&contract), (UNIT, 0));
    }

    #[test]
    #[should_panic(expected = "E22: not enough tokens in deposit")]
    fn a_transfer_above_the_balance_fails() {
        let mut contract = funded(UNIT);
        call_from(vault());

        contract.mft_transfer(
            usdc().to_string(),
            account("stranger.testnet"),
            U128(2 * UNIT),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "E22: not enough tokens in deposit")]
    fn a_withdraw_above_the_balance_fails() {
        let mut contract = funded(UNIT);

        let _ = withdraw_usdc(&mut contract, 2 * UNIT);
    }

    #[test]
    fn a_failed_transfer_is_credited_back() {
        let mut contract = funded(2 * UNIT);
        let _ = withdraw_usdc(&mut contract, 2 * UNIT);
        let mut context = VMContextBuilder::new();
        context
            .current_account_id(mock_ref())
            .predecessor_account_id(mock_ref());
        testing_env!(
            context.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );

        contract.on_withdraw(vault(), usdc(), U128(2 * UNIT), false);

        assert_eq!(balances(&contract), (2 * UNIT, 0));
    }

    #[test]
    #[should_panic(expected = "probe fault")]
    fn a_probe_fault_breaks_get_deposits() {
        let mut contract = set_up();
        set_fault(&mut contract, Fault::ProbeFails);

        contract.get_deposits(vault());
    }

    #[test]
    fn a_probe_fault_stays_until_cleared() {
        let mut contract = set_up();
        set_fault(&mut contract, Fault::ProbeFails);
        let _ = deposit(&mut contract, UNIT);
        set_fault(&mut contract, Fault::None);

        assert_eq!(balances(&contract), (UNIT, 0));
    }
}
