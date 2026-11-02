use foundling_sandbox::{
    event_data, failures, Foundling, CHAIN, COMMITMENT, NEAR_PRICE, WASM_HASH,
};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const DEPOSIT: u128 = 20_000_000;

fn buy_template() -> Value {
    json!({
        "chain": CHAIN,
        "commitment": COMMITMENT,
        "wasm_hash": WASM_HASH,
        "action": "buy_risk",
        "amount_in": "1000000",
        "ref_price": NEAR_PRICE.to_string(),
        "nonce": null,
        "vault": null,
    })
}

async fn set_fault(env: &Foundling, fault: &str) -> anyhow::Result<()> {
    let result = env
        .parent
        .call(env.rhea.id(), "set_fault")
        .args_json(json!({ "fault": fault }))
        .transact()
        .await?;
    anyhow::ensure!(result.is_success(), "set_fault: {}", failures(&result));
    Ok(())
}

/// A vault holding `DEPOSIT`, with a buy that never ran and whose answer cannot be read.
async fn stuck_on_swap() -> anyhow::Result<Foundling> {
    let env = Foundling::start().await?;
    env.ready().await?;
    env.mint(&env.usdc, env.alice.id(), DEPOSIT).await?;
    // Minting registers an account, and the mock Ref has no other way onto the tokens.
    env.mint(&env.usdc, env.rhea.id(), 1).await?;
    env.mint(&env.wnear, env.rhea.id(), 1).await?;
    let deposited = env
        .alice
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": DEPOSIT.to_string(),
            "msg": "deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(deposited.is_success(), "{}", failures(&deposited));
    set_fault(&env, "SwapGarbageNotApplied").await?;
    env.set_next(json!({"Decision": {"template": buy_template()}}))
        .await?;
    let triggered = env.trigger_cycle().await?;
    anyhow::ensure!(triggered.is_success(), "{}", failures(&triggered));
    let executed = env
        .call_vault(&env.keeper, "execute_decision", json!({"nonce": 1}))
        .await?;
    anyhow::ensure!(executed.is_success(), "{}", failures(&executed));
    let stage: Value = env.view_vault("stage", json!({})).await?;
    anyhow::ensure!(stage["Stuck"]["step"] == "Swap", "{stage}");
    Ok(env)
}

#[tokio::test]
async fn advance_reads_both_tokens_and_unwinds_a_stuck_swap() -> anyhow::Result<()> {
    let env = stuck_on_swap().await?;

    let advanced = env
        .call_vault(&env.stranger, "advance", json!({"nonce": 1}))
        .await?;

    assert!(advanced.is_success(), "{}", failures(&advanced));
    assert!(event_data(&advanced, "swap_reverted").is_some());
    let stage: Value = env.view_vault("stage", json!({})).await?;
    assert_eq!(stage, json!("Idle"));
    let book: Value = env.view_vault("book", json!({})).await?;
    assert_eq!(book["usdc"], DEPOSIT.to_string());
    let at_ref: Value = env.view_vault("rhea_book", json!({})).await?;
    assert_eq!(at_ref["usdc"], "0");
    let wallet: String = env
        .view_contract(
            &env.usdc,
            "ft_balance_of",
            json!({"account_id": env.vault_id}),
        )
        .await?;
    assert_eq!(wallet, DEPOSIT.to_string());
    Ok(())
}

#[tokio::test]
async fn a_failed_reading_stays_stuck_and_can_be_retried() -> anyhow::Result<()> {
    let env = stuck_on_swap().await?;
    set_fault(&env, "ProbeFails").await?;

    let failed = env
        .call_vault(&env.stranger, "advance", json!({"nonce": 1}))
        .await?;

    assert!(event_data(&failed, "stuck").is_some());
    let stage: Value = env.view_vault("stage", json!({})).await?;
    assert_eq!(stage["Stuck"]["step"], "Swap", "{stage}");

    set_fault(&env, "None").await?;
    let retried = env
        .call_vault(&env.stranger, "advance", json!({"nonce": 1}))
        .await?;

    assert!(retried.is_success(), "{}", failures(&retried));
    assert_eq!(
        env.view_vault::<Value>("stage", json!({})).await?,
        json!("Idle")
    );
    Ok(())
}
