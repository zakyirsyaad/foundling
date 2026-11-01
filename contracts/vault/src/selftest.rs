//! A public check that the config sealed into the vault points at the real pool, feeds
//! and decimals. Deposits wait for one pass, and a pass is final: a feed that goes null
//! later must not let anyone close the deposit door.

use near_sdk::serde::de::DeserializeOwned;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PromiseIndex};

use crate::events::emit;
use crate::{Vault, VaultExt};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const VIEW_GAS: Gas = Gas::from_tgas(20);
const ON_SELFTEST_GAS: Gas = Gas::from_tgas(30);
const MIN_SELFTEST_GAS: Gas = Gas::from_tgas(120);
/// `ft_metadata` carries the token icon, 1772 bytes on mainnet USDC.
const MAX_VIEW_BYTES: usize = 16 * 1024;
const POOL_RESULT: u64 = 0;
const ORACLE_RESULT: u64 = 1;
const USDC_RESULT: u64 = 2;
const WNEAR_RESULT: u64 = 3;
const RESULT_COUNT: u64 = 4;

#[near(serializers = [json])]
struct Pool {
    token_account_ids: Vec<AccountId>,
    total_fee: u32,
}

#[near(serializers = [json])]
struct TokenMetadata {
    decimals: u8,
}

#[near]
impl Vault {
    pub fn selftest(&mut self) {
        require!(env::prepaid_gas() >= MIN_SELFTEST_GAS, "LOW_GAS");
        require!(!self.selftest_passed, "selftest already passed");
        let views = [
            view(
                self.assets.rhea.clone(),
                "get_pool",
                json!({ "pool_id": self.assets.pool_id }),
            ),
            view(
                self.oracle.account.clone(),
                "list_prices_no_older_than",
                self.price_request(),
            ),
            view(self.assets.usdc.clone(), "ft_metadata", json!({})),
            view(self.assets.wnear.clone(), "ft_metadata", json!({})),
        ];
        let callback = env::promise_then(
            env::promise_and(&views),
            env::current_account_id(),
            "on_selftest",
            "{}",
            NO_DEPOSIT,
            ON_SELFTEST_GAS,
        );
        env::promise_return(callback);
    }

    /// Never panics, and never takes a pass back.
    #[private]
    pub fn on_selftest(&mut self) {
        match self.check_config() {
            Ok(()) => {
                self.selftest_passed = true;
                emit("selftest", r#"{"passed":true}"#);
            }
            Err(code) => emit(
                "selftest",
                &format!(r#"{{"passed":false,"code":"{code}"}}"#),
            ),
        }
    }

    pub fn selftest_passed(&self) -> bool {
        self.selftest_passed
    }
}

impl Vault {
    fn check_config(&self) -> Result<(), &'static str> {
        if env::promise_results_count() != RESULT_COUNT {
            return Err("SELFTEST_RESULTS");
        }
        let pool: Pool = read_view(POOL_RESULT).ok_or("SELFTEST_POOL")?;
        let tokens = &pool.token_account_ids;
        let is_our_pair = tokens.len() == 2
            && tokens.contains(&self.assets.usdc)
            && tokens.contains(&self.assets.wnear);
        if !is_our_pair {
            return Err("SELFTEST_POOL");
        }
        if pool.total_fee != self.assets.pool_fee_bps {
            return Err("SELFTEST_FEE");
        }
        self.read_oracle(ORACLE_RESULT)
            .map_err(|reject| reject.code())?;
        let usdc = read_view::<TokenMetadata>(USDC_RESULT).map(|token| token.decimals);
        let wnear = read_view::<TokenMetadata>(WNEAR_RESULT).map(|token| token.decimals);
        if usdc != Some(self.assets.usdc_decimals) || wnear != Some(self.assets.wnear_decimals) {
            return Err("SELFTEST_DECIMALS");
        }
        Ok(())
    }
}

fn view(account: AccountId, method: &str, args: serde_json::Value) -> PromiseIndex {
    env::promise_create(account, method, args.to_string(), NO_DEPOSIT, VIEW_GAS)
}

fn read_view<T: DeserializeOwned>(index: u64) -> Option<T> {
    let bytes = env::promise_result_checked(index, MAX_VIEW_BYTES).ok()?;
    serde_json::from_slice(&bytes).ok()
}
