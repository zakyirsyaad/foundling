//! Reusable near-workspaces harness for the Foundling vault and its mocks.
//!
//! `Foundling::start` boots a sandbox, deploys the mock tokens, mock Ref, mock oracle and
//! mock OutLayer, and creates the vault the way a born-sealed one is made: one transaction
//! from the parent that creates the account, funds it, deploys the code and calls `init`,
//! with no access key added. Later tasks (attack lab, keeper tests) build on this.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub use serde_json;

pub const COMMITMENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const WASM_HASH: &str = "bb";
pub const CHAIN: &str = "testnet";
pub const NEAR_FEED: &str = "near-id";
pub const USDC_FEED: &str = "usdc-id";
pub const POOL_ID: u64 = 4512;
pub const POOL_FEE_BPS: u32 = 30;
pub const USDC_DECIMALS: u8 = 6;
pub const WNEAR_DECIMALS: u8 = 24;
/// wNEAR in USDC with eight decimals, and what `mock-oracle` is told for NEAR/USD.
pub const NEAR_PRICE: u128 = 450_000_000;
pub const OUTLAYER_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
/// The size the vault rejects a decision above (`MAX_DECISION_BYTES` in the vault). Tests
/// take their boundary from here, and `vault_decision_limit_is_1024` pins it to the vault.
pub const MAX_DECISION_BYTES: usize = 1024;

const EVENT_PREFIX: &str = "EVENT_JSON:";
const VAULT_BALANCE: NearToken = NearToken::from_near(10);
const MOCK_BALANCE: NearToken = NearToken::from_near(5);
const ACCOUNT_BALANCE: NearToken = NearToken::from_near(20);
const THIRTY_DAYS: u64 = 30 * 24 * 60 * 60;

/// Where `make sandbox` leaves each wasm: `contracts/<dir>/target/near/<file>.wasm`.
pub fn wasm(dir: &str, file: &str) -> Vec<u8> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "contracts",
        dir,
        "target",
        "near",
        &format!("{file}.wasm"),
    ]
    .iter()
    .collect();
    std::fs::read(&path).unwrap_or_else(|err| {
        panic!(
            "cannot read {}: {err}. Run `make sandbox` so the wasm is built first.",
            path.display()
        )
    })
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before 1970")
        .as_secs()
}

/// What differs between the vault and the world it is pointed at, so a test can stage a
/// mismatch without rebuilding the harness.
#[derive(Clone, Debug)]
pub struct Setup {
    /// The fee the mock Ref reports for the pool. The vault is configured with `POOL_FEE_BPS`.
    pub ref_pool_fee_bps: u32,
    /// The vault's `open_deposits` policy. Closed keeps the allowlist of alice alone.
    pub open_deposits: bool,
    /// Policy fields to replace in the config `init` gets, as a JSON object. `init` still
    /// checks the result, so a bad combination shows up as a failed `init`.
    pub policy: Value,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            ref_pool_fee_bps: POOL_FEE_BPS,
            open_deposits: false,
            policy: json!({}),
        }
    }
}

pub struct Foundling {
    pub worker: Worker<Sandbox>,
    /// Owns the mocks and is the vault's parent. The vault id is a subaccount of it.
    pub parent: Account,
    pub governor: Account,
    pub keeper: Account,
    pub guardian: Account,
    pub alice: Account,
    pub stranger: Account,
    pub usdc: Contract,
    pub wnear: Contract,
    pub rhea: Contract,
    pub oracle: Contract,
    pub outlayer: Contract,
    pub vault_id: AccountId,
    /// The `config` argument `init` was called with.
    pub config: Value,
    /// The exact bytes of the `init` call, which the vault hashes into `args_hash`.
    pub init_args: Vec<u8>,
    pub init_result: ExecutionFinalResult,
}

impl Foundling {
    pub async fn start() -> anyhow::Result<Self> {
        Self::start_with(Setup::default()).await
    }

    /// Like `launch`, but fails when the vault's `init` fails, so a config that drifted from
    /// the contract shows up as that and not as account errors in the first call.
    pub async fn start_with(setup: Setup) -> anyhow::Result<Self> {
        let env = Self::launch(setup).await?;
        anyhow::ensure!(
            env.init_result.is_success(),
            "vault init failed, so the config in this harness may have drifted from the contract: {}",
            failures(&env.init_result)
        );
        Ok(env)
    }

    /// Boots everything and returns the result of `init` without checking it. For a test
    /// that wants to see `init` fail.
    pub async fn launch(setup: Setup) -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let parent = account(&root, "owner", ACCOUNT_BALANCE).await?;
        let governor = account(&root, "governor", ACCOUNT_BALANCE).await?;
        let keeper = account(&root, "keeper", ACCOUNT_BALANCE).await?;
        let guardian = account(&root, "guardian", ACCOUNT_BALANCE).await?;
        let alice = account(&root, "alice", ACCOUNT_BALANCE).await?;
        let stranger = account(&root, "stranger", ACCOUNT_BALANCE).await?;
        let owner = parent.id().clone();

        let usdc = deploy_mock(
            &root,
            "usdc",
            "mock_token",
            "mock-token",
            json!({"owner": owner, "name": "USDC", "symbol": "mUSDC", "decimals": USDC_DECIMALS}),
        )
        .await?;
        let wnear = deploy_mock(
            &root,
            "wnear",
            "mock_token",
            "mock-token",
            json!({"owner": owner, "name": "wNEAR", "symbol": "mwNEAR", "decimals": WNEAR_DECIMALS}),
        )
        .await?;
        let rhea = deploy_mock(
            &root,
            "rhea",
            "mock_ref",
            "mock-ref",
            json!({
                "owner": owner, "usdc": usdc.id(), "wnear": wnear.id(),
                "pool_id": POOL_ID, "total_fee": setup.ref_pool_fee_bps,
                "price": NEAR_PRICE.to_string(),
                "decimal_scale": 10u128.pow((WNEAR_DECIMALS - USDC_DECIMALS) as u32).to_string(),
            }),
        )
        .await?;
        let oracle = deploy_mock(
            &root,
            "oracle",
            "mock_oracle",
            "mock-oracle",
            json!({"owner": owner}),
        )
        .await?;
        let outlayer = deploy_mock(
            &root,
            "outlayer",
            "mock_outlayer",
            "mock-outlayer",
            json!({"owner": owner}),
        )
        .await?;

        set_feed(&parent, &oracle, NEAR_FEED, NEAR_PRICE).await?;
        set_feed(&parent, &oracle, USDC_FEED, 100_000_000).await?;

        let vault_id: AccountId = format!("vault.{}", parent.id()).parse()?;
        let mut config = vault_config(
            [&governor, &keeper, &guardian, &alice],
            [&usdc, &wnear, &rhea, &oracle, &outlayer],
            setup.open_deposits,
        );
        let overrides = setup.policy.as_object().ok_or_else(|| {
            anyhow::anyhow!("Setup.policy must be a JSON object, got {}", setup.policy)
        })?;
        for (field, value) in overrides {
            anyhow::ensure!(
                config["policy"].get(field).is_some(),
                "Setup.policy names `{field}`, which is not a policy field"
            );
            config["policy"][field] = value.clone();
        }
        let init_args = serde_json::to_vec(&json!({ "config": config }))?;
        let init_result = parent
            .batch(&vault_id)
            .create_account()
            .transfer(VAULT_BALANCE)
            .deploy(&wasm("vault", "foundling_vault"))
            .call(Function::new("init").args(init_args.clone()).max_gas())
            .transact()
            .await?;

        Ok(Self {
            worker,
            parent,
            governor,
            keeper,
            guardian,
            alice,
            stranger,
            usdc,
            wnear,
            rhea,
            oracle,
            outlayer,
            vault_id,
            config,
            init_args,
            init_result,
        })
    }

    /// Pays the vault's registration fee for `who`, which every depositor needs first.
    pub async fn register(&self, who: &Account) -> anyhow::Result<()> {
        let bounds: Value = self.view_vault("storage_balance_bounds", json!({})).await?;
        let fee: u128 = bounds["min"].as_str().unwrap_or_default().parse()?;
        let result = who
            .call(&self.vault_id, "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_yoctonear(fee))
            .transact()
            .await?;
        anyhow::ensure!(
            result.is_success(),
            "storage_deposit: {}",
            failures(&result)
        );
        Ok(())
    }

    /// Runs the one-time registrations and the selftest, and registers alice, so her
    /// deposits are accepted.
    pub async fn ready(&self) -> anyhow::Result<()> {
        for target in ["Usdc", "Wnear", "Rhea", "RheaTokens"] {
            let result = self
                .stranger
                .call(&self.vault_id, "setup_storage")
                .args_json(json!({ "target": target }))
                .max_gas()
                .transact()
                .await?;
            anyhow::ensure!(
                result.is_success(),
                "setup_storage {target}: {}",
                failures(&result)
            );
        }
        let result = self
            .stranger
            .call(&self.vault_id, "selftest")
            .max_gas()
            .transact()
            .await?;
        anyhow::ensure!(result.is_success(), "selftest: {}", failures(&result));
        anyhow::ensure!(
            self.view_vault::<bool>("selftest_passed", json!({}))
                .await?,
            "selftest did not pass: {:?}",
            events(&result)
        );
        self.register(&self.alice).await
    }

    /// Calls the vault from `who` with all the gas there is.
    pub async fn call_vault(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(&self.vault_id, method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn view_vault<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        args: Value,
    ) -> anyhow::Result<T> {
        view(&self.worker, &self.vault_id, method, args).await
    }

    pub async fn view_contract<T: serde::de::DeserializeOwned>(
        &self,
        contract: &Contract,
        method: &str,
        args: Value,
    ) -> anyhow::Result<T> {
        view(&self.worker, contract.id(), method, args).await
    }

    /// Mints mock tokens to `account`, which also registers it on the token.
    pub async fn mint(
        &self,
        token: &Contract,
        account: &AccountId,
        amount: u128,
    ) -> anyhow::Result<()> {
        let result = self
            .parent
            .call(token.id(), "mint")
            .args_json(json!({ "account_id": account, "amount": amount.to_string() }))
            .transact()
            .await?;
        anyhow::ensure!(result.is_success(), "mint: {}", failures(&result));
        Ok(())
    }

    /// Queues the mock OutLayer's answer for the next `request_execution`.
    pub async fn set_next(&self, mode: Value) -> anyhow::Result<()> {
        let result = self
            .parent
            .call(self.outlayer.id(), "set_next")
            .args_json(json!({ "mode": mode }))
            .transact()
            .await?;
        anyhow::ensure!(result.is_success(), "set_next: {}", failures(&result));
        Ok(())
    }

    pub async fn trigger_cycle(&self) -> anyhow::Result<ExecutionFinalResult> {
        self.call_vault(&self.keeper, "trigger_cycle", json!({}))
            .await
    }
}

async fn account(root: &Account, name: &str, balance: NearToken) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(balance)
        .transact()
        .await?
        .into_result()?)
}

/// Mocks `init` only from their own account, so each one is called as itself.
async fn deploy_mock(
    root: &Account,
    name: &str,
    file: &str,
    dir: &str,
    init_args: Value,
) -> anyhow::Result<Contract> {
    let account = account(root, name, MOCK_BALANCE).await?;
    let contract = account.deploy(&wasm(dir, file)).await?.into_result()?;
    let result = account
        .call(account.id(), "init")
        .args_json(init_args)
        .transact()
        .await?;
    anyhow::ensure!(result.is_success(), "{name} init: {}", failures(&result));
    Ok(contract)
}

async fn set_feed(
    owner: &Account,
    oracle: &Contract,
    price_id: &str,
    price: u128,
) -> anyhow::Result<()> {
    let result = owner
        .call(oracle.id(), "set_feed")
        .args_json(json!({
            "price_id": price_id,
            "feed": {"price": price.to_string(), "conf": "10000", "expo": -8, "lag_seconds": 0},
        }))
        .transact()
        .await?;
    anyhow::ensure!(result.is_success(), "set_feed: {}", failures(&result));
    Ok(())
}

fn vault_config(people: [&Account; 4], contracts: [&Contract; 5], open_deposits: bool) -> Value {
    let [governor, keeper, guardian, alice] = people;
    let [usdc, wnear, rhea, oracle, outlayer] = contracts;
    let wnear_unit = 10u128.pow(24);
    json!({
        "roles": {"governor": governor.id(), "keeper": keeper.id(), "guardian": guardian.id()},
        "assets": {
            "usdc": usdc.id(), "wnear": wnear.id(), "rhea": rhea.id(),
            "pool_id": POOL_ID, "pool_fee_bps": POOL_FEE_BPS,
            "usdc_decimals": USDC_DECIMALS, "wnear_decimals": WNEAR_DECIMALS,
        },
        "agent": {
            "outlayer": outlayer.id(),
            "wasm_url": "https://example.com/strategy.wasm",
            "wasm_hash": WASM_HASH,
            "secrets_profile": "sandbox",
            "secrets_owner": governor.id(),
            "outlayer_deposit": OUTLAYER_DEPOSIT.to_string(),
            "chain": CHAIN,
            "commitment": COMMITMENT,
            "reveal_after": now_seconds() + THIRTY_DAYS,
            "max_instructions": 2_000_000_000u64,
            "max_memory_mb": 256,
            "build_target": "wasm32-wasip2",
        },
        "oracle": {"account": oracle.id(), "near_id": NEAR_FEED, "usdc_id": USDC_FEED},
        "policy": {
            "cap_bps": 1_000, "epoch_cap_bps": 2_000,
            "cap_usdc": "15000000", "epoch_cap_usdc": "30000000",
            "cap_wnear": (4 * wnear_unit).to_string(),
            "epoch_cap_wnear": (8 * wnear_unit).to_string(),
            "cap_sell_bps": 5_000,
            "dust_wnear": (wnear_unit / 100).to_string(),
            "max_risk_bps": 5_000,
            "epoch_len": 21_600, "cooldown": 1_800,
            "slippage_bps": 150, "price_max_age": 120,
            "price_max_conf_bps": 50, "ref_dev_bps": 200,
            "decision_ttl": 600, "abort_after_blocks": 450,
            "stuck_after": 600, "halt_after": 3_600,
            "max_execution_seconds": 45,
            "ops_budget": (6 * wnear_unit / 10).to_string(),
            "near_reserve": (3 * wnear_unit / 10).to_string(),
            "tvl_cap": "100000000", "per_user_cap": "50000000",
            "min_deposit": "1000000", "max_mint_per_cycle": 8,
            "timelock": 86_400, "open_deposits": open_deposits,
        },
        "allowlist": [alice.id()],
    })
}

async fn view<T: serde::de::DeserializeOwned>(
    worker: &Worker<Sandbox>,
    contract: &AccountId,
    method: &str,
    args: Value,
) -> anyhow::Result<T> {
    Ok(worker
        .view(contract, method)
        .args_json(args)
        .await?
        .json::<T>()?)
}

/// The NEP-297 events in a result, as `{event, data}` objects in log order.
pub fn events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix(EVENT_PREFIX))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .collect()
}

/// The `data[0]` of the first event called `name`.
pub fn event_data(result: &ExecutionFinalResult, name: &str) -> Option<Value> {
    events(result)
        .into_iter()
        .find(|event| event["event"] == name)
        .map(|event| event["data"][0].clone())
}

/// Every failure in the result, as text a test can search for a reason code.
pub fn failures(result: &ExecutionFinalResult) -> String {
    format!("{:?}", result.failures())
}
