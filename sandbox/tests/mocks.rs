use foundling_sandbox::{
    event_data, failures, Foundling, CHAIN, COMMITMENT, NEAR_PRICE, OUTLAYER_DEPOSIT, WASM_HASH,
};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const MAX_RESPONSE_BYTES: usize = 1024;

fn decision_template() -> Value {
    json!({
        "chain": CHAIN,
        "commitment": COMMITMENT,
        "wasm_hash": WASM_HASH,
        "action": "buy_risk",
        "amount_in": "7000000",
        "ref_price": NEAR_PRICE.to_string(),
        "nonce": null,
        "vault": null,
    })
}

async fn stage(env: &Foundling) -> anyhow::Result<Value> {
    env.view_vault("stage", json!({})).await
}

#[tokio::test]
async fn mock_outlayer_returns_configured_decision() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!({"Decision": {"template": decision_template()}}))
        .await?;

    let result = env.trigger_cycle().await?;

    assert!(result.is_success(), "{}", failures(&result));
    let event = event_data(&result, "decision").expect("a decision event");
    assert_eq!(event["nonce"], 1);
    let received: Value = serde_json::from_str(event["decision"].as_str().unwrap())?;
    assert_eq!(received["v"], 1);
    assert_eq!(received["vault"], env.vault_id.as_str());
    assert_eq!(received["chain"], CHAIN);
    assert_eq!(received["nonce"], 1);
    assert_eq!(received["action"], "buy_risk");
    assert_eq!(received["amount_in"], "7000000");
    assert_eq!(received["ref_price"], NEAR_PRICE.to_string());
    assert_eq!(received["commitment"], COMMITMENT);
    assert_eq!(received["wasm_hash"], WASM_HASH);
    assert!(event_data(&result, "decision_ready").is_some());
    assert_eq!(stage(&env).await?["DecisionReady"]["nonce"], 1);

    let request: Value = env
        .view_contract(&env.outlayer, "last_request", json!({}))
        .await?;
    assert_eq!(request["payer_account_id"], env.vault_id.as_str());
    assert_eq!(request["deposit"], OUTLAYER_DEPOSIT.to_string());
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap())?;
    assert_eq!(input["vault"], env.vault_id.as_str());
    assert_eq!(input["nonce"], 1);
    assert_eq!(request["oversize"], false);
    Ok(())
}

#[tokio::test]
async fn mock_outlayer_simulates_null_result() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!("Null")).await?;

    let result = env.trigger_cycle().await?;

    assert!(result.is_success(), "{}", failures(&result));
    let failed = event_data(&result, "cycle_failed").expect("a cycle_failed event");
    assert_eq!(failed, json!({"nonce": 1, "code": "NULL_RESULT"}));
    assert!(event_data(&result, "decision").is_none());
    assert_eq!(stage(&env).await?, json!("Idle"));
    let request: Value = env
        .view_contract(&env.outlayer, "last_request", json!({}))
        .await?;
    assert_eq!(request["response_len"], 4);
    Ok(())
}

#[tokio::test]
async fn mock_outlayer_rejects_oversize_payload() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!({"Raw": {"payload": "x".repeat(MAX_RESPONSE_BYTES + 1)}}))
        .await?;

    let result = env.trigger_cycle().await?;

    assert!(result.is_success(), "{}", failures(&result));
    let request: Value = env
        .view_contract(&env.outlayer, "last_request", json!({}))
        .await?;
    assert_eq!(request["oversize"], true);
    assert_eq!(request["response_len"], MAX_RESPONSE_BYTES + 1);
    assert!(result
        .logs()
        .iter()
        .any(|log| log.contains("oversize answer")));
    let failed = event_data(&result, "cycle_failed").expect("a cycle_failed event");
    assert_eq!(failed, json!({"nonce": 1, "code": "OVERSIZE"}));
    assert_eq!(stage(&env).await?, json!("Idle"));
    Ok(())
}

#[tokio::test]
async fn mock_outlayer_failed_status_ends_the_cycle() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!("Failed")).await?;

    let result = env.trigger_cycle().await?;

    let failed = event_data(&result, "cycle_failed").expect("a cycle_failed event");
    assert_eq!(failed, json!({"nonce": 1, "code": "REQUEST_FAILED"}));
    assert_eq!(stage(&env).await?, json!("Idle"));
    let count: u64 = env
        .view_contract(&env.outlayer, "request_count", json!({}))
        .await?;
    assert_eq!(count, 0, "a failed request is not recorded");
    Ok(())
}

#[tokio::test]
async fn mock_token_transfer_call_credits_vault() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.ready().await?;
    env.mint(&env.usdc, env.alice.id(), 20_000_000).await?;

    let result = env
        .alice
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": "5000000",
            "msg": "deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(result.is_success(), "{}", failures(&result));
    let queued = event_data(&result, "deposit_queued").expect("ft_on_transfer ran");
    assert_eq!(queued["account"], env.alice.id().as_str());
    assert_eq!(queued["amount"], "5000000");
    let pending: String = env
        .view_vault("pending_of", json!({"account": env.alice.id()}))
        .await?;
    assert_eq!(pending, "5000000");
    let balance_of = |who: &near_workspaces::AccountId| {
        env.view_contract::<String>(&env.usdc, "ft_balance_of", json!({"account_id": who}))
    };
    assert_eq!(balance_of(&env.vault_id).await?, "5000000");
    assert_eq!(balance_of(env.alice.id()).await?, "15000000");
    Ok(())
}

#[tokio::test]
async fn mock_token_refunds_a_deposit_the_vault_refuses() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.ready().await?;
    env.mint(&env.usdc, env.alice.id(), 20_000_000).await?;

    let result = env
        .alice
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": "5000000",
            "msg": "not-a-deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    assert!(result.is_success(), "{}", failures(&result));
    assert!(event_data(&result, "deposit_queued").is_none());
    let balance: String = env
        .view_contract(
            &env.usdc,
            "ft_balance_of",
            json!({"account_id": env.alice.id()}),
        )
        .await?;
    assert_eq!(balance, "20000000");
    Ok(())
}
