//! Executing an approved decision: read the anchor, apply the limits, then swap on Ref in
//! three hops. Each hop reads a return value; a balance difference is never trusted.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PromiseError};

use crate::cycle::Stage;
use crate::decision::{Action, Decision};
use crate::events::emit;
use crate::limits::{check_buy, check_sell, BuyContext, SellContext};
use crate::math::mul_div;
use crate::pricing::{read_anchor, Anchor, PriceLimits, PriceReject};
use crate::{now_seconds, Token, Vault, VaultExt};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const ORACLE_GAS: Gas = Gas::from_tgas(20);
const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(60);
const SWAP_GAS: Gas = Gas::from_tgas(50);
const WITHDRAW_GAS: Gas = Gas::from_tgas(50);
// Each callback carries the next hop, because unused gas does not flow into a callback.
const ON_WITHDRAWN_GAS: Gas = Gas::from_tgas(15);
const ON_SWAPPED_GAS: Gas = Gas::from_tgas(75);
const ON_DEPOSITED_GAS: Gas = Gas::from_tgas(135);
const ON_PRICE_GAS: Gas = Gas::from_tgas(205);
const MIN_EXECUTE_GAS: Gas = Gas::from_tgas(240);
const MAX_ORACLE_BYTES: usize = 2 * 1024;
const ORACLE_RESULT: u64 = 0;
const MAX_HOP_BYTES: usize = 128;
const FIRST_ATTEMPT: u32 = 0;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapStep {
    Deposit,
    Swap,
    Withdraw,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Inflight {
    pub nonce: u64,
    pub token_in: Token,
    pub token_out: Token,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub amount_out: Option<U128>,
    /// Total shares at the debit, the denominator of every claim on this swap.
    pub shares_snapshot: U128,
    /// Shares redeemed while this swap ran. Their part of the result goes to the bucket.
    pub shares_burned: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bucket {
    pub token: Token,
    pub result: U128,
    pub snapshot: U128,
}

struct Trade {
    token_in: Token,
    token_out: Token,
    amount_in: u128,
    min_amount_out: u128,
}

enum Hop {
    Failed,
    Amount(u128),
    Unreadable,
}

#[near]
impl Vault {
    pub fn execute_decision(&mut self, nonce: u64) {
        require!(env::prepaid_gas() >= MIN_EXECUTE_GAS, "LOW_GAS");
        require!(
            env::predecessor_account_id() == self.roles.keeper,
            "NOT_KEEPER"
        );
        let Stage::DecisionReady {
            nonce: active,
            expires_at,
        } = self.stage
        else {
            env::panic_str("NOT_READY");
        };
        require!(active == nonce, "NOT_READY");
        require!(now_seconds() < expires_at, "EXPIRED");
        require!(!self.frozen, "FROZEN");
        require!(!self.halted, "HALTED");
        self.stage = Stage::AwaitingPrice {
            nonce,
            entered_block: env::block_height(),
            expires_at,
        };

        let read = env::promise_create(
            self.oracle.account.clone(),
            "list_prices_no_older_than",
            self.price_request().to_string(),
            NO_DEPOSIT,
            ORACLE_GAS,
        );
        return_callback(read, "on_price", json!({ "nonce": nonce }), ON_PRICE_GAS);
    }

    /// Never panics. A price that is merely unavailable keeps the decision, so the keeper
    /// can retry without paying for a new run.
    #[private]
    pub fn on_price(&mut self, nonce: u64) {
        let Stage::AwaitingPrice {
            nonce: active,
            expires_at,
            ..
        } = self.stage
        else {
            return;
        };
        if active != nonce {
            return;
        }
        let Some(decision) = self.decision.clone() else {
            self.stage = Stage::Idle;
            return;
        };
        if self.frozen || self.halted {
            let code = if self.frozen { "FROZEN" } else { "HALTED" };
            self.reject(nonce, code);
            return;
        }
        let anchor = match self.read_oracle(ORACLE_RESULT) {
            Ok(anchor) => anchor,
            Err(PriceReject::Unavailable) => {
                emit_rejected(nonce, PriceReject::Unavailable.code());
                self.stage = Stage::DecisionReady { nonce, expires_at };
                return;
            }
            Err(reject) => {
                self.reject(nonce, reject.code());
                return;
            }
        };
        if !anchor.accepts_ref_price(decision.ref_price.0, self.policy.ref_dev_bps) {
            self.reject(nonce, PriceReject::Deviation.code());
            return;
        }
        match self.approved_trade(&decision, &anchor) {
            Ok(trade) => self.start_swap(nonce, trade),
            Err(code) => self.reject(nonce, code),
        }
    }

    #[private]
    pub fn on_deposited(&mut self, nonce: u64, attempt: u32) {
        if !matches!(self.stage, Stage::Depositing { nonce: n, attempt: a, .. } if n == nonce && a == attempt)
        {
            return;
        }
        let Some(inflight) = self.inflight.clone() else {
            return;
        };
        match read_hop() {
            Hop::Amount(used) if used == inflight.amount_in.0 => {
                self.add_rhea(inflight.token_in, used);
                if self.frozen || self.halted {
                    self.start_withdraw(nonce, attempt, inflight.token_in, used, true);
                } else {
                    self.start_ref_swap(&inflight, attempt);
                }
            }
            Hop::Failed | Hop::Amount(0) => {
                self.settle_swap(nonce, inflight.token_in, inflight.amount_in.0, true);
            }
            _ => self.mark_stuck(nonce, SwapStep::Deposit),
        }
    }

    #[private]
    pub fn on_swapped(&mut self, nonce: u64, attempt: u32) {
        if !matches!(self.stage, Stage::Swapping { nonce: n, attempt: a, .. } if n == nonce && a == attempt)
        {
            return;
        }
        let Some(mut inflight) = self.inflight.clone() else {
            return;
        };
        match read_hop() {
            // Ref never returns 0 here, and `withdraw` would read it as "take everything".
            Hop::Amount(0) | Hop::Unreadable => self.mark_stuck(nonce, SwapStep::Swap),
            Hop::Amount(amount_out) => {
                inflight.amount_out = Some(U128(amount_out));
                self.remove_rhea(inflight.token_in, inflight.amount_in.0);
                self.add_rhea(inflight.token_out, amount_out);
                self.inflight = Some(inflight.clone());
                self.start_withdraw(nonce, attempt, inflight.token_out, amount_out, false);
            }
            Hop::Failed => self.start_withdraw(
                nonce,
                attempt,
                inflight.token_in,
                inflight.amount_in.0,
                true,
            ),
        }
    }

    #[private]
    pub fn on_withdrawn(&mut self, nonce: u64, attempt: u32) {
        let Stage::Withdrawing {
            nonce: active,
            attempt: current,
            unwinding,
            token,
            amount,
            ..
        } = self.stage
        else {
            return;
        };
        if active != nonce || current != attempt {
            return;
        }
        match read_hop() {
            Hop::Amount(delivered) if delivered == amount.0 => {
                self.remove_rhea(token, delivered);
                self.settle_swap(nonce, token, delivered, unwinding);
            }
            // A partial delivery waits for the probe, which can see what actually arrived
            // and split it with the bucket. Crediting it here would skip that split.
            _ => self.mark_stuck(nonce, SwapStep::Withdraw),
        }
    }

    #[payable]
    pub fn claim_bucket(&mut self, nonce: u64) {
        assert_one_yocto();
        self.require_transfer_gas(1);
        let Some(bucket) = self.buckets.get(&nonce).cloned() else {
            env::panic_str("bucket not resolved");
        };
        let account = env::predecessor_account_id();
        let Some(shares) = self.bucket_claims.remove(&(nonce, account.clone())) else {
            env::panic_str("nothing to claim");
        };
        let amount = mul_div(bucket.result.0, shares, bucket.snapshot.0);
        emit(
            "claimed",
            &format!(r#"{{"account":"{account}","nonce":{nonce},"amount":"{amount}"}}"#),
        );
        if amount > 0 {
            self.send_token(account, bucket.token, amount);
        }
    }

    pub fn inflight(&self) -> Option<Inflight> {
        self.inflight.clone()
    }

    pub fn window_used(&self, token_in: Token) -> U128 {
        U128(
            self.window_of(token_in)
                .used(now_seconds(), self.policy.epoch_len),
        )
    }
}

impl Vault {
    pub(crate) fn price_request(&self) -> serde_json::Value {
        json!({
            "price_ids": [self.oracle.near_id, self.oracle.usdc_id],
            "age": self.policy.price_max_age,
        })
    }

    pub(crate) fn read_oracle(&self, result_index: u64) -> Result<Anchor, PriceReject> {
        let bytes = env::promise_result_checked(result_index, MAX_ORACLE_BYTES)
            .map_err(|_| PriceReject::Unavailable)?;
        read_anchor(
            &bytes,
            &PriceLimits {
                near_id: &self.oracle.near_id,
                usdc_id: &self.oracle.usdc_id,
                now: now_seconds(),
                max_age: self.policy.price_max_age,
                max_conf_bps: self.policy.price_max_conf_bps,
            },
        )
    }

    fn approved_trade(&self, decision: &Decision, anchor: &Anchor) -> Result<Trade, &'static str> {
        let amount_in = decision.amount_in.0;
        if amount_in == 0 {
            return Err("BAD_DECISION");
        }
        let scale = self.decimal_scale();
        let slippage = self.policy.slippage_bps;
        let now = now_seconds();
        let epoch_len = self.policy.epoch_len;
        match decision.action {
            Action::BuyRisk => {
                let wnear_value = anchor.wnear_value(self.wnear_book, scale);
                let buy = BuyContext {
                    amount_in,
                    nav_usdc: self.usdc_book + wnear_value,
                    usdc_book: self.usdc_book,
                    wnear_value_usdc: wnear_value,
                    window_used: self.buy_window.used(now, epoch_len),
                };
                check_buy(&self.policy, &buy).map_err(|reject| reject.code())?;
                Ok(Trade {
                    token_in: Token::Usdc,
                    token_out: Token::Wnear,
                    amount_in,
                    min_amount_out: anchor.min_out_buy(amount_in, slippage, scale),
                })
            }
            Action::SellRisk => {
                let sell = SellContext {
                    amount_in,
                    wnear_book: self.wnear_book,
                    window_used: self.sell_window.used(now, epoch_len),
                };
                check_sell(&self.policy, &sell).map_err(|reject| reject.code())?;
                Ok(Trade {
                    token_in: Token::Wnear,
                    token_out: Token::Usdc,
                    amount_in,
                    min_amount_out: anchor.min_out_sell(amount_in, slippage, scale),
                })
            }
            Action::None => Err("BAD_DECISION"),
        }
    }

    fn start_swap(&mut self, nonce: u64, trade: Trade) {
        let now = now_seconds();
        let epoch_len = self.policy.epoch_len;
        let window = self
            .window_of(trade.token_in)
            .pruned(now, epoch_len)
            .recorded(now, trade.amount_in);
        match trade.token_in {
            Token::Usdc => {
                self.usdc_book -= trade.amount_in;
                self.buy_window = window;
            }
            Token::Wnear => {
                self.wnear_book -= trade.amount_in;
                self.sell_window = window;
            }
        }
        self.decision = None;
        self.inflight = Some(Inflight {
            nonce,
            token_in: trade.token_in,
            token_out: trade.token_out,
            amount_in: U128(trade.amount_in),
            min_amount_out: U128(trade.min_amount_out),
            amount_out: None,
            shares_snapshot: U128(self.total_shares),
            shares_burned: U128(0),
        });
        self.stage = Stage::Depositing {
            nonce,
            attempt: FIRST_ATTEMPT,
            entered_at: now,
        };
        emit("swap_started", &format!(r#"{{"nonce":{nonce}}}"#));

        let transfer = env::promise_create(
            self.token_account(trade.token_in),
            "ft_transfer_call",
            json!({
                "receiver_id": self.assets.rhea,
                "amount": U128(trade.amount_in),
                "msg": "",
            })
            .to_string(),
            ONE_YOCTO,
            FT_TRANSFER_CALL_GAS,
        );
        return_callback(
            transfer,
            "on_deposited",
            json!({ "nonce": nonce, "attempt": FIRST_ATTEMPT }),
            ON_DEPOSITED_GAS,
        );
    }

    fn start_ref_swap(&mut self, inflight: &Inflight, attempt: u32) {
        let nonce = inflight.nonce;
        self.stage = Stage::Swapping {
            nonce,
            attempt,
            entered_at: now_seconds(),
        };
        let swap = env::promise_create(
            self.assets.rhea.clone(),
            "swap",
            json!({
                "actions": [{
                    "pool_id": self.assets.pool_id,
                    "token_in": self.token_account(inflight.token_in),
                    "token_out": self.token_account(inflight.token_out),
                    "amount_in": inflight.amount_in,
                    "min_amount_out": inflight.min_amount_out,
                }],
            })
            .to_string(),
            ONE_YOCTO,
            SWAP_GAS,
        );
        return_callback(
            swap,
            "on_swapped",
            json!({ "nonce": nonce, "attempt": attempt }),
            ON_SWAPPED_GAS,
        );
    }

    fn start_withdraw(
        &mut self,
        nonce: u64,
        attempt: u32,
        token: Token,
        amount: u128,
        unwinding: bool,
    ) {
        self.stage = Stage::Withdrawing {
            nonce,
            attempt,
            entered_at: now_seconds(),
            unwinding,
            token,
            amount: U128(amount),
        };
        let withdraw = env::promise_create(
            self.assets.rhea.clone(),
            "withdraw",
            json!({
                "token_id": self.token_account(token),
                "amount": U128(amount),
                "unregister": null,
                "skip_unwrap_near": true,
            })
            .to_string(),
            ONE_YOCTO,
            WITHDRAW_GAS,
        );
        return_callback(
            withdraw,
            "on_withdrawn",
            json!({ "nonce": nonce, "attempt": attempt }),
            ON_WITHDRAWN_GAS,
        );
    }

    /// Credits the book net of what holders who redeemed mid-swap are owed, so a mint at
    /// the next flat point cannot be priced on money that already has an owner.
    fn settle_swap(&mut self, nonce: u64, token: Token, result: u128, unwinding: bool) {
        let Some(inflight) = self.inflight.take() else {
            return;
        };
        let burned = inflight.shares_burned.0;
        let reserved = if burned > 0 {
            self.buckets.insert(
                nonce,
                Bucket {
                    token,
                    result: U128(result),
                    snapshot: inflight.shares_snapshot,
                },
            );
            mul_div(result, burned, inflight.shares_snapshot.0)
        } else {
            0
        };
        self.credit(token, result - reserved);
        self.stage = Stage::Idle;
        if unwinding {
            emit(
                "swap_reverted",
                &format!(r#"{{"nonce":{nonce},"amount":"{result}"}}"#),
            );
        } else {
            let amount_in = inflight.amount_in.0;
            emit(
                "executed",
                &format!(
                    r#"{{"nonce":{nonce},"amount_in":"{amount_in}","amount_out":"{result}"}}"#
                ),
            );
        }
    }

    fn mark_stuck(&mut self, nonce: u64, step: SwapStep) {
        self.stage = Stage::Stuck {
            nonce,
            step,
            since: now_seconds(),
        };
        emit(
            "stuck",
            &format!(r#"{{"nonce":{nonce},"step":"{step:?}"}}"#),
        );
    }

    fn reject(&mut self, nonce: u64, code: &str) {
        emit_rejected(nonce, code);
        self.decision = None;
        self.stage = Stage::Idle;
    }

    /// Called by `redeem`: shares burned mid-swap keep their claim on the result.
    pub(crate) fn note_burn_during_swap(&mut self, account: &AccountId, shares: u128) {
        let Some(inflight) = self.inflight.as_mut() else {
            return;
        };
        inflight.shares_burned = U128(inflight.shares_burned.0 + shares);
        let key = (inflight.nonce, account.clone());
        let held = self.bucket_claims.get(&key).copied().unwrap_or(0);
        self.bucket_claims.insert(key, held + shares);
    }

    fn credit(&mut self, token: Token, amount: u128) {
        match token {
            Token::Usdc => self.usdc_book += amount,
            Token::Wnear => self.wnear_book += amount,
        }
    }

    fn add_rhea(&mut self, token: Token, amount: u128) {
        match token {
            Token::Usdc => self.rhea_usdc += amount,
            Token::Wnear => self.rhea_wnear += amount,
        }
    }

    fn remove_rhea(&mut self, token: Token, amount: u128) {
        match token {
            Token::Usdc => self.rhea_usdc = self.rhea_usdc.saturating_sub(amount),
            Token::Wnear => self.rhea_wnear = self.rhea_wnear.saturating_sub(amount),
        }
    }

    fn window_of(&self, token_in: Token) -> &crate::limits::Window {
        match token_in {
            Token::Usdc => &self.buy_window,
            Token::Wnear => &self.sell_window,
        }
    }

    fn decimal_scale(&self) -> u128 {
        10u128.pow((self.assets.wnear_decimals - self.assets.usdc_decimals) as u32)
    }
}

fn emit_rejected(nonce: u64, code: &str) {
    emit(
        "rejected",
        &format!(r#"{{"nonce":{nonce},"code":"{code}"}}"#),
    );
}

fn return_callback(
    promise: near_sdk::PromiseIndex,
    method: &str,
    args: serde_json::Value,
    gas: Gas,
) {
    let callback = env::promise_then(
        promise,
        env::current_account_id(),
        method,
        args.to_string(),
        NO_DEPOSIT,
        gas,
    );
    env::promise_return(callback);
}

fn read_hop() -> Hop {
    if env::promise_results_count() != 1 {
        return Hop::Failed;
    }
    match env::promise_result_checked(0, MAX_HOP_BYTES) {
        Err(PromiseError::Failed) => Hop::Failed,
        Err(_) => Hop::Unreadable,
        Ok(bytes) => match serde_json::from_slice::<U128>(&bytes) {
            Ok(amount) => Hop::Amount(amount.0),
            Err(_) => Hop::Unreadable,
        },
    }
}
