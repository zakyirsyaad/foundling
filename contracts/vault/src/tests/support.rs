use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::json;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{
    serde_json, test_vm_config, testing_env, AccountId, Gas, NearToken, PromiseResult,
    RuntimeFeesConfig,
};

use crate::cycle::AgentConfig;
use crate::setup::SetupTarget;
use crate::tests::policy::demo_policy;
use crate::{Assets, InitConfig, OracleConfig, Roles, Vault};

pub const START_SECONDS: u64 = 1_800_000_000;
const NANOS_PER_SECOND: u64 = 1_000_000_000;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

pub fn vault_id() -> AccountId {
    account("vault.owner.near")
}

pub fn parent() -> AccountId {
    account("owner.near")
}

pub fn governor() -> AccountId {
    account("governor.near")
}

pub fn keeper() -> AccountId {
    account("keeper.near")
}

pub fn guardian() -> AccountId {
    account("guardian.near")
}

pub fn usdc() -> AccountId {
    account("usdc.near")
}

pub fn wnear() -> AccountId {
    account("wrap.near")
}

pub fn rhea() -> AccountId {
    account("rhea.near")
}

pub fn outlayer() -> AccountId {
    account("outlayer.near")
}

pub fn oracle() -> AccountId {
    account("oracle.near")
}

pub fn alice() -> AccountId {
    account("alice.near")
}

pub fn bob() -> AccountId {
    account("bob.near")
}

pub fn context(predecessor: AccountId, seconds: u64) -> VMContextBuilder {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(vault_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .account_balance(NearToken::from_near(5))
        .block_timestamp((START_SECONDS + seconds) * NANOS_PER_SECOND)
        .prepaid_gas(Gas::from_tgas(300));
    ctx
}

pub fn set_caller(who: AccountId) {
    testing_env!(context(who, 0).build());
}

pub fn set_caller_at(who: AccountId, seconds: u64) {
    testing_env!(context(who, seconds - START_SECONDS).build());
}

pub fn set_caller_with_yocto(who: AccountId) {
    let mut ctx = context(who, 0);
    ctx.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(ctx.build());
}

pub fn set_caller_with_balance(who: AccountId, balance: NearToken) {
    let mut ctx = context(who, 0);
    ctx.account_balance(balance);
    testing_env!(ctx.build());
}

pub fn set_caller_with_gas(who: AccountId, gas: Gas) {
    let mut ctx = context(who, 0);
    ctx.prepaid_gas(gas);
    testing_env!(ctx.build());
}

pub fn set_caller_at_block(who: AccountId, block: u64) {
    let mut ctx = context(who, 0);
    ctx.block_height(block);
    testing_env!(ctx.build());
}

pub fn set_callback(results: Vec<PromiseResult>) {
    let ctx = context(vault_id(), 0).build();
    testing_env!(
        ctx,
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

pub fn init_config() -> InitConfig {
    InitConfig {
        roles: Roles {
            governor: governor(),
            keeper: keeper(),
            guardian: guardian(),
        },
        assets: Assets {
            usdc: usdc(),
            wnear: wnear(),
            rhea: rhea(),
            pool_id: 4512,
            pool_fee_bps: 30,
            usdc_decimals: 6,
            wnear_decimals: 24,
        },
        agent: AgentConfig {
            outlayer: outlayer(),
            wasm_url: "https://example.com/strategy.wasm".to_string(),
            wasm_hash: "bb".to_string(),
            secrets_profile: "sp2".to_string(),
            secrets_owner: account("owner-secrets.near"),
            outlayer_deposit: U128(50_000_000_000_000_000_000_000),
            chain: "testnet".to_string(),
            commitment: "aa".to_string(),
        },
        oracle: OracleConfig {
            account: oracle(),
            near_id: "near-id".to_string(),
            usdc_id: "usdc-id".to_string(),
        },
        policy: demo_policy(),
        allowlist: vec![alice(), bob()],
    }
}

pub fn new_vault() -> Vault {
    set_caller(parent());
    Vault::init(init_config())
}

pub fn finish_setup(vault: &mut Vault, target: SetupTarget) {
    set_caller(alice());
    vault.setup_storage(target);
    set_callback(vec![PromiseResult::Successful(Vec::new())]);
    vault.on_setup(target);
}

pub fn set_up_vault() -> Vault {
    let mut vault = new_vault();
    for target in [
        SetupTarget::Usdc,
        SetupTarget::Wnear,
        SetupTarget::Rhea,
        SetupTarget::RheaTokens,
    ] {
        finish_setup(&mut vault, target);
    }
    vault
}

pub fn selftest_results() -> Vec<PromiseResult> {
    let feed = |price: &str| json!({"price": price, "conf": "10000", "expo": -8, "publish_time": START_SECONDS - 30});
    let replies = [
        json!({"token_account_ids": [usdc(), wnear()], "total_fee": 30, "amounts": ["1", "1"]}),
        json!({"near-id": feed("450000000"), "usdc-id": feed("100000000")}),
        json!({"spec": "ft-1.0.0", "decimals": 6, "icon": null}),
        json!({"spec": "ft-1.0.0", "decimals": 24, "icon": null}),
    ];
    replies
        .iter()
        .map(|reply| PromiseResult::Successful(reply.to_string().into_bytes()))
        .collect()
}

pub fn ready_vault() -> Vault {
    let mut vault = set_up_vault();
    set_caller(alice());
    vault.selftest();
    set_callback(selftest_results());
    vault.on_selftest();
    vault
}

pub fn call_to(receiver: &AccountId) -> (String, serde_json::Value, NearToken) {
    let receipts = get_created_receipts();
    let receipt = receipts
        .iter()
        .find(|receipt| &receipt.receiver_id == receiver)
        .unwrap();
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        ..
    } = &receipt.actions[0]
    else {
        panic!("expected a function call");
    };
    (
        String::from_utf8(method_name.clone()).unwrap(),
        serde_json::from_slice(args).unwrap(),
        *attached_deposit,
    )
}

pub fn logs_contain(text: &str) -> bool {
    get_logs().iter().any(|log| log.contains(text))
}
