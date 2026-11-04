use foundling_sandbox::{failures, Foundling, Setup};
use serde_json::{json, Value};

#[tokio::test]
async fn setup_policy_overrides_reach_the_vault_and_leave_the_rest_alone() -> anyhow::Result<()> {
    let env = Foundling::start_with(Setup {
        policy: json!({"epoch_len": 600, "cooldown": 60}),
        ..Default::default()
    })
    .await?;

    let policy: Value = env.view_vault("policy", json!({})).await?;

    assert_eq!(policy["epoch_len"], 600);
    assert_eq!(policy["cooldown"], 60);
    assert_eq!(
        policy["cap_bps"], 1_000,
        "a field not named keeps its default"
    );
    assert_eq!(
        env.config["policy"]["epoch_len"], 600,
        "config records what init got"
    );
    Ok(())
}

#[tokio::test]
async fn setup_policy_the_vault_refuses_makes_init_fail_and_start_say_so() -> anyhow::Result<()> {
    let setup = Setup {
        policy: json!({"epoch_len": 100, "cooldown": 60}),
        ..Default::default()
    };

    let env = Foundling::launch(setup.clone()).await?;
    assert!(
        env.init_result.is_failure(),
        "epoch_len under two cooldowns"
    );
    assert!(failures(&env.init_result).contains("epoch_len"));

    let started = Foundling::start_with(setup).await;
    assert!(started.is_err());
    Ok(())
}
