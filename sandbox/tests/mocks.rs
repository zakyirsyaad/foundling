use foundling_sandbox::{
    event_data, failures, Foundling, CHAIN, COMMITMENT, MAX_DECISION_BYTES, NEAR_PRICE,
    OUTLAYER_DEPOSIT, WASM_HASH,
};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// A third of the 30 TGas `on_decision` gets, the headroom the SPEC asks of callbacks.
const ON_DECISION_LIMIT_TGAS: u64 = 10;

async fn run_fee(env: &Foundling) -> anyhow::Result<u128> {
    let fee: String = env
        .view_contract(&env.outlayer, "run_fee", json!({}))
        .await?;
    Ok(fee.parse()?)
}

/// Calls the mock directly, with the deposit a run needs, so a test can send it more than
/// one request without waiting out the vault's cooldown.
async fn direct_request(
    env: &Foundling,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(env
        .stranger
        .call(env.outlayer.id(), "request_execution")
        .args_json(json!({
            "source": {}, "resource_limits": null, "input_data": "{}", "secrets_ref": null,
            "response_format": null, "payer_account_id": env.stranger.id(), "params": null,
        }))
        .deposit(NearToken::from_yoctonear(run_fee(env).await? * 2))
        .max_gas()
        .transact()
        .await?)
}

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
async fn vault_rejects_oversize_answer() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!({"Raw": {"payload": "x".repeat(MAX_DECISION_BYTES + 1)}}))
        .await?;

    let result = env.trigger_cycle().await?;

    assert!(result.is_success(), "{}", failures(&result));
    let request: Value = env
        .view_contract(&env.outlayer, "last_request", json!({}))
        .await?;
    assert_eq!(request["oversize"], true);
    assert_eq!(request["response_len"], MAX_DECISION_BYTES + 1);
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

    assert!(result.is_success(), "{}", failures(&result));
    let failed = event_data(&result, "cycle_failed").expect("a cycle_failed event");
    assert_eq!(failed, json!({"nonce": 1, "code": "REQUEST_FAILED"}));
    assert_eq!(stage(&env).await?, json!("Idle"));
    let count: u64 = env
        .view_contract(&env.outlayer, "request_count", json!({}))
        .await?;
    assert_eq!(count, 1, "the request reached the mock and was recorded");
    let queued: u32 = env
        .view_contract(&env.outlayer, "queued", json!({}))
        .await?;
    assert_eq!(queued, 0, "the Failed entry left the queue");
    Ok(())
}

#[tokio::test]
async fn mock_outlayer_answers_the_request_after_a_failed_one() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!("Failed")).await?;
    env.set_next(json!({"Raw": {"payload": "after"}})).await?;

    let first = direct_request(&env).await?;
    let queued: u32 = env
        .view_contract(&env.outlayer, "queued", json!({}))
        .await?;
    let second = direct_request(&env).await?;

    assert!(first.is_failure(), "the first request fails");
    assert_eq!(queued, 1, "only the Failed entry is consumed");
    assert!(second.is_success(), "{}", failures(&second));
    assert_eq!(second.unwrap().raw_bytes()?, b"after");
    Ok(())
}

#[tokio::test]
async fn mock_outlayer_keeps_a_fixed_fee_and_refunds_the_rest() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    let fee = run_fee(&env).await?;
    let mock_before = env.outlayer.view_account().await?.balance;
    let vault_before = env.worker.view_account(&env.vault_id).await?.balance;

    let result = env.trigger_cycle().await?;

    assert!(result.is_success(), "{}", failures(&result));
    let mock_after = env.outlayer.view_account().await?.balance;
    let vault_after = env.worker.view_account(&env.vault_id).await?.balance;
    let kept = mock_after
        .as_yoctonear()
        .saturating_sub(mock_before.as_yoctonear());
    let spent = vault_before
        .as_yoctonear()
        .saturating_sub(vault_after.as_yoctonear());
    assert!(kept >= fee, "the mock keeps at least the fee: {kept}");
    assert!(
        kept < OUTLAYER_DEPOSIT / 2,
        "the mock does not keep the deposit: {kept}"
    );
    assert!(
        spent < OUTLAYER_DEPOSIT / 2,
        "the vault gets the change back: {spent}"
    );
    Ok(())
}

#[tokio::test]
async fn vault_decision_limit_is_1024() -> anyhow::Result<()> {
    for (size, code) in [
        (MAX_DECISION_BYTES, "MALFORMED"),
        (MAX_DECISION_BYTES + 1, "OVERSIZE"),
    ] {
        let env = Foundling::start().await?;
        env.set_next(json!({"Raw": {"payload": "x".repeat(size)}}))
            .await?;

        let result = env.trigger_cycle().await?;

        let request: Value = env
            .view_contract(&env.outlayer, "last_request", json!({}))
            .await?;
        assert_eq!(
            request["oversize"],
            size > MAX_DECISION_BYTES,
            "{size} bytes"
        );
        let failed = event_data(&result, "cycle_failed").expect("a cycle_failed event");
        assert_eq!(failed["code"], code, "{size} bytes");
    }
    Ok(())
}

#[tokio::test]
async fn the_largest_decision_fits_the_callback_and_stays_readable() -> anyhow::Result<()> {
    let run = |mode: Value| async move {
        let env = Foundling::start().await?;
        env.set_next(mode).await?;
        let result = env.trigger_cycle().await?;
        assert!(result.is_success(), "{}", failures(&result));
        let event = event_data(&result, "decision").expect("a decision event");
        let kept: Option<String> = env
            .view_vault("published_decision", json!({"nonce": 1}))
            .await?;
        assert_eq!(kept.as_deref(), event["decision"].as_str());
        let callback = result
            .outcomes()
            .into_iter()
            .find(|outcome| {
                outcome
                    .logs
                    .iter()
                    .any(|log| log.contains("decision_ready"))
            })
            .expect("the callback outcome");
        anyhow::Ok((kept.unwrap(), callback.gas_burnt.as_tgas()))
    };

    let (short, _) = run(json!({"Decision": {"template": decision_template()}})).await?;
    let padding = "a".repeat(MAX_DECISION_BYTES - short.len());
    let padded = short.replacen(
        r#""inputs_digest":""#,
        &format!(r#""inputs_digest":"{padding}"#),
        1,
    );
    let (largest, burnt_tgas) = run(json!({"Raw": {"payload": padded}})).await?;

    assert_eq!(largest.len(), MAX_DECISION_BYTES);
    assert!(burnt_tgas <= ON_DECISION_LIMIT_TGAS, "{burnt_tgas} TGas");
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
    let balance_of = |who: &near_workspaces::AccountId| {
        env.view_contract::<String>(&env.usdc, "ft_balance_of", json!({"account_id": who}))
    };
    assert_eq!(balance_of(env.alice.id()).await?, "20000000");
    assert_eq!(
        balance_of(&env.vault_id).await?,
        "0",
        "the vault keeps none"
    );
    let pending: String = env
        .view_vault("pending_of", json!({"account": env.alice.id()}))
        .await?;
    assert_eq!(pending, "0", "nothing is queued for the refused deposit");
    let net: String = env
        .view_vault("net_deposit_of", json!({"account": env.alice.id()}))
        .await?;
    assert_eq!(net, "0");
    Ok(())
}
