use foundling_sandbox::{
    event_data, events, failures, Foundling, Setup, CHAIN, COMMITMENT, POOL_FEE_BPS, USDC_DECIMALS,
    WNEAR_DECIMALS,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn sandbox_deploys_and_inits_vault() -> anyhow::Result<()> {
    let env = Foundling::start().await?;

    assert!(
        env.init_result.is_success(),
        "{}",
        failures(&env.init_result)
    );
    let expected = hex(&Sha256::digest(&env.init_args));
    let data = event_data(&env.init_result, "initialized")
        .unwrap_or_else(|| panic!("no initialized event in {:?}", events(&env.init_result)));
    assert_eq!(data["args_hash"], expected);
    assert_eq!(
        env.view_vault::<String>("args_hash", json!({})).await?,
        expected
    );

    let keys = env.worker.view_access_keys(&env.vault_id).await?;
    assert!(keys.is_empty(), "a born-sealed vault has no access key");
    Ok(())
}

#[tokio::test]
async fn sandbox_selftest_reflects_config() -> anyhow::Result<()> {
    let env = Foundling::start().await?;

    let result = env.call_vault(&env.stranger, "selftest", json!({})).await?;

    assert!(result.is_success(), "{}", failures(&result));
    assert_eq!(
        event_data(&result, "selftest"),
        Some(json!({"passed": true}))
    );
    assert!(env.view_vault::<bool>("selftest_passed", json!({})).await?);

    let assets: Value = env.view_vault("assets", json!({})).await?;
    assert_eq!(assets["pool_fee_bps"], POOL_FEE_BPS);
    assert_eq!(assets["usdc_decimals"], USDC_DECIMALS);
    assert_eq!(assets["wnear_decimals"], WNEAR_DECIMALS);
    assert_eq!(assets["usdc"], env.usdc.id().as_str());
    assert_eq!(assets["rhea"], env.rhea.id().as_str());
    let agent: Value = env.view_vault("agent", json!({})).await?;
    assert_eq!(agent["commitment"], COMMITMENT);
    assert_eq!(agent["chain"], CHAIN);
    Ok(())
}

#[tokio::test]
async fn sandbox_selftest_rejects_a_pool_fee_that_differs_from_the_config() -> anyhow::Result<()> {
    let env = Foundling::start_with(Setup {
        ref_pool_fee_bps: 25,
        ..Setup::default()
    })
    .await?;

    let result = env.call_vault(&env.stranger, "selftest", json!({})).await?;

    assert!(result.is_success(), "{}", failures(&result));
    let data = event_data(&result, "selftest").expect("selftest event");
    assert_eq!(data, json!({"passed": false, "code": "SELFTEST_FEE"}));
    assert!(!env.view_vault::<bool>("selftest_passed", json!({})).await?);
    Ok(())
}

#[tokio::test]
async fn sandbox_trigger_cycle_requires_keeper() -> anyhow::Result<()> {
    let env = Foundling::start().await?;

    let result = env
        .call_vault(&env.stranger, "trigger_cycle", json!({}))
        .await?;

    assert!(result.is_failure());
    assert!(
        failures(&result).contains("NOT_KEEPER"),
        "{}",
        failures(&result)
    );
    let stage: Value = env.view_vault("stage", json!({})).await?;
    assert_eq!(stage, json!("Idle"));
    assert_eq!(env.view_vault::<u64>("last_nonce", json!({})).await?, 0);
    Ok(())
}
