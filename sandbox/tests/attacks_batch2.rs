//! Attack Lab, second five attacks (SPEC section 5, S3 and S4): kill-agent, governor-loosen,
//! double-redeem, forged-caller, freeze-race. Same contract as attacks_batch1.rs: each test attacks a
//! sandbox vault, writes `<name>.json` in the proof directory with its verdict and the ledger
//! before and after, and only then asserts, so `tools/attacks/<name>` can tell a breach (exit 1)
//! from a tool error (exit 2). The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as in batch 1.

mod common;

use common::*;
use foundling_sandbox::{events, failures, Foundling};
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

fn count(result: &near_workspaces::result::ExecutionFinalResult, event: &str) -> usize {
    events(result).iter().filter(|e| e["event"] == event).count()
}

fn pro_rata(book: u128, shares: u128, total: u128) -> u128 {
    book * shares / total
}

/// One `redeem` as an action of a batch. Two of them share the 300 TGas of a transaction, so each
/// gets 130, which is above the 95 the vault wants for two transfers.
fn redeem_action(shares: u128) -> Function {
    Function::new("redeem")
        .args_json(json!({ "shares": shares.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(130))
}

fn withdraw_action(token: &str) -> Function {
    Function::new("withdraw_claimable")
        .args_json(json!({ "token": token }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(130))
}

/// A call that carries the 1 yoctoNEAR `redeem` and `withdraw_claimable` demand before they check anything else.
async fn pay_call(
    env: &Foundling,
    who: &Account,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(&env.vault_id, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

async fn batch_of(
    env: &Foundling,
    who: &Account,
    actions: Vec<Function>,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let mut batch = who.batch(&env.vault_id);
    for action in actions {
        batch = batch.call(action);
    }
    Ok(batch.transact().await?)
}

/// Two redeems in one batch, and a transfer that fails because the redeemer has no wallet on the
/// token. Book and shares are debited before any transfer leaves, so the failed leg can only
/// become `claimable` for exactly what it was, and nothing is paid twice. The redeemer is alice,
/// registered on USDC (she deposited it) and not on wNEAR, so the wNEAR leg of every payout fails.
#[tokio::test]
async fn double_redeem() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("double-redeem", &[]);
    settle_deposit(&env).await?;
    let bought = decide(&env, template("buy_risk", DEPOSIT / 10)).await?;
    anyhow::ensure!(bought.started, "setup failed: the buy should trade: {bought:?}");
    let (usdc_book, wnear_book) = book(&env).await?;
    let held = shares_of(&env, &env.alice).await?;
    anyhow::ensure!(
        wnear_book > 0 && wallet_of(&env, &env.wnear, env.alice.id()).await.unwrap_or(0) == 0,
        "setup failed: the vault needs wNEAR, and alice must have none"
    );
    let total = total_shares(&env).await?;
    anyhow::ensure!(total == held, "setup failed: alice should be the only holder");
    run.context(
        "setup: the vault holds USDC and wNEAR and alice has no wallet on the wNEAR token",
        json!({"book_usdc": usdc_book.to_string(), "book_wnear": wnear_book.to_string(), "alice_shares": held.to_string()}),
    );
    let before = ledger(&env).await?;
    let start = state(&env).await?;

    // The same shares twice in one transaction: the second action fails and the transaction
    // fails as one, so the first payout does not go out either.
    let overdraw = batch_of(&env, &env.alice, vec![redeem_action(held), redeem_action(held)]).await?;
    let text = refused_text(&overdraw);
    run.step(
        "redeem all shares twice in one batch",
        refusal(text.as_deref(), &["not enough shares"]).is_some()
            && !overdraw
                .outcomes()
                .iter()
                .any(|outcome| outcome.executor_id == *env.usdc.id())
            && wallet_of(&env, &env.usdc, env.alice.id()).await? == 0
            && state(&env).await? == start,
        None,
        json!({"refused_with": refusal(text.as_deref(), &["not enough shares"]), "state_unchanged": state(&env).await? == start,
               "note": "the failed action's log line remains in the outcome, its state change and its transfer do not"}),
    );

    // Two redeems that fit in one batch both pay, each from the book as the one before left it.
    let quarter = held / 4;
    let first_usdc = pro_rata(usdc_book, quarter, total);
    let first_wnear = pro_rata(wnear_book, quarter, total);
    let second_usdc = pro_rata(usdc_book - first_usdc, quarter, total - quarter);
    let second_wnear = pro_rata(wnear_book - first_wnear, quarter, total - quarter);
    anyhow::ensure!(first_usdc > 0 && first_wnear > 0 && second_wnear > 0, "setup failed: payouts too small");
    let usdc_wallet = wallet_of(&env, &env.usdc, env.alice.id()).await?;
    let pair = batch_of(&env, &env.alice, vec![redeem_action(quarter), redeem_action(quarter)]).await?;
    anyhow::ensure!(pair.is_success(), "control failed: two redeems that fit should pass: {}", failures(&pair));
    let (usdc_after, wnear_after) = book(&env).await?;
    let paid_usdc = wallet_of(&env, &env.usdc, env.alice.id()).await? - usdc_wallet;
    let claim_wnear = claimable(&env, &env.alice, "Wnear").await?;
    run.step(
        "two redeems of a quarter each in one batch pay once each, pro rata",
        count(&pair, "redeemed") == 2
            && paid_usdc == first_usdc + second_usdc
            && usdc_after == usdc_book - paid_usdc
            && wnear_after == wnear_book - first_wnear - second_wnear,
        None,
        json!({"redeemed_events": count(&pair, "redeemed"), "usdc_paid": paid_usdc.to_string(), "usdc_due": (first_usdc + second_usdc).to_string(),
               "book_after": {"usdc": usdc_after.to_string(), "wnear": wnear_after.to_string()}}),
    );
    run.step(
        "the wNEAR legs failed on an unregistered wallet and became claimable, exactly",
        count(&pair, "transfer_failed") == 2
            && claim_wnear == first_wnear + second_wnear
            && wallet_of(&env, &env.wnear, env.alice.id()).await.unwrap_or(0) == 0
            && claimable(&env, &env.alice, "Usdc").await? == 0
            && wallet_of(&env, &env.wnear, &env.vault_id).await? == wnear_after + claim_wnear,
        None,
        json!({"transfer_failed_events": count(&pair, "transfer_failed"), "claimable_wnear": claim_wnear.to_string(),
               "due": (first_wnear + second_wnear).to_string(), "vault_wnear_wallet_covers_book_plus_claim": true}),
    );

    // The original share count is no longer there to redeem.
    let after_pair = state(&env).await?;
    let again = pay_call(&env, &env.alice, "redeem", json!({"shares": held.to_string()})).await?;
    let text = refused_text(&again);
    run.step(
        "redeem the original share count again after the pair",
        refusal(text.as_deref(), &["not enough shares"]).is_some() && state(&env).await? == after_pair,
        None,
        json!({"refused_with": refusal(text.as_deref(), &["not enough shares"])}),
    );

    // The rest in one redeem leaves no shares, and one more share is refused.
    let rest = shares_of(&env, &env.alice).await?;
    let last = redeem(&env, &env.alice, rest).await?;
    run.step("the remaining shares redeem once, in full", last.exact(), None, last.detail());
    anyhow::ensure!(book(&env).await? == (0, 0), "alice was the only holder, so the book should be empty");
    let emptied = state(&env).await?;
    let extra = pay_call(&env, &env.alice, "redeem", json!({"shares": "1"}))
        .await?;
    let text = refused_text(&extra);
    run.step(
        "one more share after everything was redeemed",
        refusal(text.as_deref(), &["not enough shares"]).is_some() && state(&env).await? == emptied,
        None,
        json!({"refused_with": refusal(text.as_deref(), &["not enough shares"])}),
    );

    // Everything paid or claimable adds up to the book alice started with, and nothing more.
    let owed = claimable(&env, &env.alice, "Wnear").await?;
    run.step(
        "paid plus claimable equals the book, token by token",
        wallet_of(&env, &env.usdc, env.alice.id()).await? == usdc_book
            && owed == wnear_book
            && wallet_of(&env, &env.wnear, &env.vault_id).await? == owed
            && wallet_of(&env, &env.usdc, &env.vault_id).await? == 0,
        None,
        json!({"alice_usdc": wallet_of(&env, &env.usdc, env.alice.id()).await?.to_string(), "usdc_book_before": usdc_book.to_string(),
               "claimable_wnear": owed.to_string(), "wnear_book_before": wnear_book.to_string()}),
    );

    // Claiming into a wallet that still does not exist on the token changes nothing.
    let held_back = state(&env).await?;
    let blind = pay_call(&env, &env.alice, "withdraw_claimable", json!({"token": "Wnear"}))
        .await?;
    run.step(
        "withdraw_claimable while still unregistered on wNEAR keeps the whole claim",
        count(&blind, "transfer_failed") == 1 && state(&env).await? == held_back,
        None,
        json!({"claimable_wnear": claimable(&env, &env.alice, "Wnear").await?.to_string()}),
    );

    // Once registered (a mint of one unit does that), two claims in one batch fail as one.
    env.mint(&env.wnear, env.alice.id(), 1).await?;
    let registered = state(&env).await?;
    let twice = batch_of(&env, &env.alice, vec![withdraw_action("Wnear"), withdraw_action("Wnear")]).await?;
    let text = refused_text(&twice);
    run.step(
        "withdraw_claimable twice in one batch",
        refusal(text.as_deref(), &["nothing claimable"]).is_some() && state(&env).await? == registered,
        None,
        json!({"refused_with": refusal(text.as_deref(), &["nothing claimable"])}),
    );

    let paid = pay_call(&env, &env.alice, "withdraw_claimable", json!({"token": "Wnear"}))
        .await?;
    anyhow::ensure!(paid.is_success(), "control failed: one claim should pay: {}", failures(&paid));
    run.step(
        "one claim pays the whole claimable once",
        wallet_of(&env, &env.wnear, env.alice.id()).await? == 1 + owed
            && claimable(&env, &env.alice, "Wnear").await? == 0
            && wallet_of(&env, &env.wnear, &env.vault_id).await? == 0,
        None,
        json!({"alice_wnear": wallet_of(&env, &env.wnear, env.alice.id()).await?.to_string(), "claimed": owed.to_string()}),
    );
    let settled = state(&env).await?;
    let repeat = pay_call(&env, &env.alice, "withdraw_claimable", json!({"token": "Wnear"}))
        .await?;
    let text = refused_text(&repeat);
    run.step(
        "claim again",
        refusal(text.as_deref(), &["nothing claimable"]).is_some() && state(&env).await? == settled,
        None,
        json!({"refused_with": refusal(text.as_deref(), &["nothing claimable"])}),
    );

    run.finish(&env, before, ledger(&env).await?)
}
