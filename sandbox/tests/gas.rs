use foundling_sandbox::{failures, Foundling, CHAIN, COMMITMENT, NEAR_PRICE, WASM_HASH};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const MIN_DEPOSIT: u128 = 1_000_000;
/// `max_mint_per_cycle` in the sandbox policy, which is also the default in the spec.
const MINT_LIMIT: usize = 8;
/// `MIN_TRIGGER_GAS` in the vault, the least a keeper may attach.
const MIN_TRIGGER_TGAS: u64 = 250;
/// `MIN_TRIGGER_GAS` less the 230 handed on leaves 20, and half of that stays as margin.
const TRIGGER_LIMIT_TGAS: u64 = 10;
/// A subaccount of `test.near` at the 64 byte limit, so every key in state is the longest.
const LONGEST_NAME_BYTES: usize = 54;

fn hold_template() -> Value {
    json!({
        "chain": CHAIN,
        "commitment": COMMITMENT,
        "wasm_hash": WASM_HASH,
        "action": "hold",
        "amount_in": "0",
        "ref_price": NEAR_PRICE.to_string(),
        "nonce": null,
        "vault": null,
    })
}

async fn queue_deposit(env: &Foundling, index: usize) -> anyhow::Result<Account> {
    let name = format!("{index:02}{}", "d".repeat(LONGEST_NAME_BYTES - 2));
    let depositor = env
        .worker
        .root_account()?
        .create_subaccount(&name)
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let added = env
        .call_vault(
            &env.governor,
            "add_depositor",
            json!({"account": depositor.id()}),
        )
        .await?;
    anyhow::ensure!(added.is_success(), "{}", failures(&added));
    env.register(&depositor).await?;
    env.mint(&env.usdc, depositor.id(), MIN_DEPOSIT).await?;
    let deposited = depositor
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": MIN_DEPOSIT.to_string(),
            "msg": "deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(deposited.is_success(), "{}", failures(&deposited));
    Ok(depositor)
}

#[tokio::test]
async fn the_least_gas_a_keeper_may_attach_mints_a_full_queue() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.ready().await?;
    let mut depositors = Vec::new();
    for index in 0..=MINT_LIMIT {
        depositors.push(queue_deposit(&env, index).await?);
    }
    env.set_next(json!({"Decision": {"template": hold_template()}}))
        .await?;

    let result = env
        .keeper
        .call(&env.vault_id, "trigger_cycle")
        .gas(Gas::from_tgas(MIN_TRIGGER_TGAS))
        .transact()
        .await?;

    assert!(result.is_success(), "{}", failures(&result));
    let trigger = result
        .outcomes()
        .into_iter()
        .find(|outcome| outcome.logs.iter().any(|log| log.contains("cycle_started")))
        .expect("the trigger outcome");
    let burnt = trigger.gas_burnt.as_tgas();
    assert!(burnt <= TRIGGER_LIMIT_TGAS, "{burnt} TGas");
    assert_eq!(
        result
            .logs()
            .iter()
            .filter(|log| log.contains("\"minted\""))
            .count(),
        MINT_LIMIT
    );
    let mut still_queued = 0;
    for depositor in &depositors {
        let queued: String = env
            .view_vault("pending_of", json!({"account": depositor.id()}))
            .await?;
        still_queued += usize::from(queued != "0");
    }
    assert_eq!(still_queued, 1);
    Ok(())
}
