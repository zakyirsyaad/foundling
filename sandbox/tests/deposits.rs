use foundling_sandbox::{event_data, failures, Foundling, Setup};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const DEPOSIT: u128 = 5_000_000;
/// yoctoNEAR per byte of storage, fixed by the protocol.
const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
const CANCEL_TGAS: u64 = 60;
/// Under the sandbox root, `test.near`, this makes a 64-character id: the longest allowed.
const LONGEST_NAME_BYTES: usize = 54;

async fn open_vault() -> anyhow::Result<Foundling> {
    let env = Foundling::start_with(Setup {
        open_deposits: true,
        ..Default::default()
    })
    .await?;
    env.ready().await?;
    Ok(env)
}

async fn registration_fee(env: &Foundling) -> anyhow::Result<u128> {
    let bounds: Value = env.view_vault("storage_balance_bounds", json!({})).await?;
    Ok(bounds["min"].as_str().unwrap_or_default().parse()?)
}

/// NEAR the vault holds beyond what its storage locks.
async fn free_near(env: &Foundling) -> anyhow::Result<u128> {
    let details = env.worker.view_account(&env.vault_id).await?;
    Ok(details.balance.as_yoctonear() - u128::from(details.storage_usage) * STORAGE_BYTE_COST)
}

async fn longest_stranger(env: &Foundling) -> anyhow::Result<Account> {
    Ok(env
        .worker
        .root_account()?
        .create_subaccount(&"s".repeat(LONGEST_NAME_BYTES))
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?)
}

async fn deposit_as(env: &Foundling, who: &Account) -> anyhow::Result<ExecutionFinalResult> {
    env.mint(&env.usdc, who.id(), DEPOSIT).await?;
    Ok(who
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": DEPOSIT.to_string(),
            "msg": "deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

#[tokio::test]
async fn an_open_vault_queues_a_registered_stranger() -> anyhow::Result<()> {
    let env = open_vault().await?;
    env.register(&env.stranger).await?;

    let result = deposit_as(&env, &env.stranger).await?;

    assert!(result.is_success(), "{}", failures(&result));
    let queued = event_data(&result, "deposit_queued").expect("the deposit was queued");
    assert_eq!(queued["account"], env.stranger.id().as_str());
    let pending: String = env
        .view_vault("pending_of", json!({"account": env.stranger.id()}))
        .await?;
    assert_eq!(pending, DEPOSIT.to_string());
    Ok(())
}

/// The vault holds no way to send NEAR, so the runtime's refund on panic is the only refund.
#[tokio::test]
async fn a_wrong_registration_fee_stays_with_the_payer() -> anyhow::Result<()> {
    let env = open_vault().await?;
    let fee = registration_fee(&env).await?;
    let before = env.stranger.view_account().await?.balance;

    let result = env
        .stranger
        .call(&env.vault_id, "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(fee + 1))
        .transact()
        .await?;

    assert!(result.is_failure(), "a wrong fee must be refused");
    let after = env.stranger.view_account().await?.balance;
    assert!(
        before.as_yoctonear() - after.as_yoctonear() < fee / 2,
        "the payer lost more than gas: {before} -> {after}"
    );
    let balance: Option<Value> = env
        .view_vault(
            "storage_balance_of",
            json!({"account_id": env.stranger.id()}),
        )
        .await?;
    assert!(balance.is_none());
    Ok(())
}

/// The spam loop of an open vault, with the longest id there is: register, deposit, cancel.
/// The fee must leave the vault with at least the free NEAR it had, so cycles never stop on
/// `NEAR_RESERVE` because of it.
#[tokio::test]
async fn deposit_then_cancel_costs_the_vault_no_free_near() -> anyhow::Result<()> {
    let env = open_vault().await?;
    let spammer = longest_stranger(&env).await?;
    let before = free_near(&env).await?;

    env.register(&spammer).await?;
    let deposited = deposit_as(&env, &spammer).await?;
    assert!(deposited.is_success(), "{}", failures(&deposited));
    let cancelled = spammer
        .call(&env.vault_id, "cancel_deposit")
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(CANCEL_TGAS))
        .transact()
        .await?;
    assert!(cancelled.is_success(), "{}", failures(&cancelled));

    let after = free_near(&env).await?;
    assert!(after >= before, "free NEAR fell from {before} to {after}");
    Ok(())
}
