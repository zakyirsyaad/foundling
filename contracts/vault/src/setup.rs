//! One-time registration on the tokens and on Ref, paid from the vault's own NEAR.
//! It stays out of `init` so one failed registration cannot leave a half-built sealed vault.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PromiseError};

use crate::events::emit;
use crate::{Vault, VaultExt};

const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const REF_STORAGE: NearToken = NearToken::from_millinear(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const SETUP_CALL_GAS: Gas = Gas::from_tgas(30);
const ON_SETUP_GAS: Gas = Gas::from_tgas(10);
const SETUP_RESULT_MAX_BYTES: usize = 256;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupTarget {
    Usdc,
    Wnear,
    Rhea,
    RheaTokens,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SetupStep {
    #[default]
    None,
    InFlight,
    Done,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetupState {
    pub usdc: SetupStep,
    pub wnear: SetupStep,
    pub rhea: SetupStep,
    pub rhea_tokens: SetupStep,
}

impl SetupState {
    fn step(&self, target: SetupTarget) -> SetupStep {
        match target {
            SetupTarget::Usdc => self.usdc,
            SetupTarget::Wnear => self.wnear,
            SetupTarget::Rhea => self.rhea,
            SetupTarget::RheaTokens => self.rhea_tokens,
        }
    }

    fn with_step(&self, target: SetupTarget, step: SetupStep) -> Self {
        let mut state = self.clone();
        match target {
            SetupTarget::Usdc => state.usdc = step,
            SetupTarget::Wnear => state.wnear = step,
            SetupTarget::Rhea => state.rhea = step,
            SetupTarget::RheaTokens => state.rhea_tokens = step,
        }
        state
    }

    fn is_done(&self) -> bool {
        [self.usdc, self.wnear, self.rhea, self.rhea_tokens]
            .iter()
            .all(|step| *step == SetupStep::Done)
    }
}

#[near]
impl Vault {
    /// Anyone may call it. The flag goes in before the promise, so a batch of calls
    /// cannot drain the vault's NEAR: Ref storage surplus cannot be withdrawn again.
    pub fn setup_storage(&mut self, target: SetupTarget) {
        require!(
            self.setup.step(target) == SetupStep::None,
            "setup already started"
        );
        require!(
            target != SetupTarget::RheaTokens || self.setup.rhea == SetupStep::Done,
            "Ref storage first"
        );
        let (receiver, method, args, deposit) = self.setup_call(target);
        self.require_near_floor(deposit.as_yoctonear());
        self.setup = self.setup.with_step(target, SetupStep::InFlight);

        let call = env::promise_create(receiver, method, args, deposit, SETUP_CALL_GAS);
        env::promise_then(
            call,
            env::current_account_id(),
            "on_setup",
            json!({ "target": target }).to_string(),
            NO_DEPOSIT,
            ON_SETUP_GAS,
        );
    }

    #[private]
    pub fn on_setup(&mut self, target: SetupTarget) {
        let failed = matches!(
            env::promise_result_checked(0, SETUP_RESULT_MAX_BYTES),
            Err(PromiseError::Failed)
        );
        let step = if failed {
            SetupStep::None
        } else {
            SetupStep::Done
        };
        self.setup = self.setup.with_step(target, step);
        emit("setup_step", &format!(r#"{{"failed":{failed}}}"#));
    }

    pub fn is_setup_done(&self) -> bool {
        self.setup.is_done()
    }
}

impl Vault {
    fn setup_call(&self, target: SetupTarget) -> (AccountId, &'static str, String, NearToken) {
        match target {
            SetupTarget::Usdc => token_storage(self.assets.usdc.clone()),
            SetupTarget::Wnear => token_storage(self.assets.wnear.clone()),
            SetupTarget::Rhea => (
                self.assets.rhea.clone(),
                "storage_deposit",
                json!({ "registration_only": false }).to_string(),
                REF_STORAGE,
            ),
            SetupTarget::RheaTokens => (
                self.assets.rhea.clone(),
                "register_tokens",
                json!({ "token_ids": [self.assets.usdc, self.assets.wnear] }).to_string(),
                ONE_YOCTO,
            ),
        }
    }

    /// I11: state writes, `redeem` included, must not fail for lack of NEAR.
    pub(crate) fn has_near_floor(&self, spend: u128) -> bool {
        let stake = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear() >= stake + self.policy.near_reserve.0 + spend
    }

    pub(crate) fn require_near_floor(&self, spend: u128) {
        require!(self.has_near_floor(spend), "NEAR_RESERVE");
    }
}

fn token_storage(token: AccountId) -> (AccountId, &'static str, String, NearToken) {
    (
        token,
        "storage_deposit",
        json!({ "registration_only": true }).to_string(),
        TOKEN_STORAGE,
    )
}
