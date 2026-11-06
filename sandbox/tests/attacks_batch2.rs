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

/// Every account but the keeper that has a reason to try: a stranger, the vault's own parent, and
/// each role holder. The guardian and the governor are the ones whose key leaking is in the threat model.
fn foreign_callers(env: &Foundling) -> Vec<(&'static str, &Account)> {
    vec![
        ("stranger", &env.stranger),
        ("parent", &env.parent),
        ("governor", &env.governor),
        ("guardian", &env.guardian),
        ("alice", &env.alice),
    ]
}

/// `#[private]` is enforced by the exported entry point of the WASM, so a unit test cannot see
/// it (SPEC 3.5). Each callback is called from every foreign account, with arguments a real
/// callback could carry, and the state must not move. The SDK refuses these with "Method X is
/// private". The vault emits no NOT_ALLOWED anywhere, so that code is recorded as not exercised.
#[tokio::test]
async fn forged_caller() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("forged-caller", &["NOT_KEEPER", "NOT_ALLOWED"]);
    let before = settle_deposit(&env).await?;
    let nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    run.context(
        "control: the real callbacks ran in the setup cycle, so these methods are live",
        json!({"cycle_nonce": nonce, "stage": stage(&env).await?}),
    );

    let callbacks: Vec<(&str, serde_json::Value)> = vec![
        ("on_decision", json!({"nonce": nonce})),
        ("on_price", json!({"nonce": nonce})),
        ("on_deposited", json!({"nonce": nonce, "attempt": 1})),
        ("on_swapped", json!({"nonce": nonce, "attempt": 1})),
        ("on_withdrawn", json!({"nonce": nonce, "attempt": 1})),
        ("on_probe", json!({"nonce": nonce, "attempt": 1})),
        (
            "on_xfer",
            json!({"account": env.stranger.id(), "token": "Usdc", "amount": "999999999"}),
        ),
        ("on_setup", json!({"target": "Usdc"})),
        ("on_selftest", json!({})),
    ];
    let start = state(&env).await?;
    let mut refused = Vec::new();
    let mut leaked = Vec::new();
    for (method, args) in &callbacks {
        for (who, account) in foreign_callers(&env) {
            let result = env.call_vault(account, method, args.clone()).await?;
            let text = refused_text(&result);
            if refusal(text.as_deref(), &["is private"]).is_some() {
                refused.push(format!("{who}->{method}"));
            } else {
                leaked.push(json!({"caller": who, "method": method, "result": text}));
            }
        }
    }
    let total = callbacks.len() * foreign_callers(&env).len();
    run.step(
        "every #[private] callback, called from every foreign account",
        refused.len() == total && leaked.is_empty() && state(&env).await? == start,
        None,
        json!({"calls": total, "refused_as_private": refused.len(), "not_refused": leaked, "state_unchanged": state(&env).await? == start,
               "refused_with": "Method <name> is private"}),
    );

    let missing = env
        .call_vault(&env.stranger, "on_forged", json!({}))
        .await?;
    run.context(
        "control: a method that does not exist reads differently, so 'is private' is the guard and not a missing method",
        json!({"text": refused_text(&missing).map(|t| t.contains("MethodNotFound"))}),
    );
    anyhow::ensure!(
        refused_text(&missing).is_some_and(|t| t.contains("MethodNotFound")),
        "control failed: a missing method should read MethodNotFound"
    );

    // ft_on_transfer is not private. It refuses by handing the whole amount back.
    let direct = env
        .call_vault(
            &env.stranger,
            "ft_on_transfer",
            json!({"sender_id": env.alice.id(), "amount": "5000000", "msg": "deposit"}),
        )
        .await?;
    run.step(
        "ft_on_transfer called directly by an account that is not the USDC contract",
        direct.is_success()
            && direct.json::<String>()? == "5000000"
            && state(&env).await? == start,
        None,
        json!({"returned": "5000000 (all of it, unused)", "state_unchanged": state(&env).await? == start}),
    );

    // Alice is allowed, registered and under every cap, so the token is the only thing wrong.
    env.mint(&env.wnear, env.alice.id(), 5_000_000).await?;
    let wnear_start = state(&env).await?;
    let foreign = env
        .alice
        .call(env.wnear.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": env.vault_id, "amount": "5000000", "msg": "deposit"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(foreign.is_success(), "ft_transfer_call: {}", failures(&foreign));
    run.step(
        "a deposit that arrives through another token contract, with everything else valid",
        wallet_of(&env, &env.wnear, env.alice.id()).await? == 5_000_000
            && wallet_of(&env, &env.wnear, &env.vault_id).await? == 0
            && state(&env).await? == wnear_start,
        None,
        json!({"alice_wnear_back": "5000000", "vault_wnear_wallet": "0", "pending_alice": env.view_vault::<String>("pending_of", json!({"account": env.alice.id()})).await?}),
    );

    // Keeper-only methods from everyone else.
    let mut keeper_refusals = Vec::new();
    let mut slipped = Vec::new();
    for (who, account) in foreign_callers(&env) {
        let result = env.call_vault(account, "trigger_cycle", json!({})).await?;
        let text = refused_text(&result);
        match refusal(text.as_deref(), &["NOT_KEEPER"]) {
            Some(_) => keeper_refusals.push(format!("{who}->trigger_cycle")),
            None => slipped.push(json!({"caller": who, "method": "trigger_cycle", "result": text})),
        }
    }
    let after_trigger = state(&env).await?;
    run.step(
        "trigger_cycle from every non-keeper",
        slipped.is_empty() && after_trigger == wnear_start,
        keeper_refusals.first().map(|_| "NOT_KEEPER"),
        json!({"refused": keeper_refusals, "slipped": slipped}),
    );

    let ready_nonce = decision_ready(&env, template("buy_risk", 1_000_000)).await?;
    let ready = state(&env).await?;
    let mut execute_refusals = Vec::new();
    let mut executed = Vec::new();
    for (who, account) in foreign_callers(&env) {
        let result = env
            .call_vault(account, "execute_decision", json!({"nonce": ready_nonce}))
            .await?;
        let text = refused_text(&result);
        match refusal(text.as_deref(), &["NOT_KEEPER"]) {
            Some(_) if !swapped(&result) => execute_refusals.push(format!("{who}->execute_decision")),
            _ => executed.push(json!({"caller": who, "method": "execute_decision", "result": text})),
        }
    }
    run.step(
        "execute_decision on a ready decision, with the right nonce, from every non-keeper",
        executed.is_empty()
            && execute_refusals.len() == foreign_callers(&env).len()
            && state(&env).await? == ready
            && stage(&env).await?.get("DecisionReady").is_some(),
        execute_refusals.first().map(|_| "NOT_KEEPER"),
        json!({"nonce": ready_nonce, "refused": execute_refusals, "executed": executed, "stage": stage(&env).await?}),
    );
    let real = execute(&env, ready_nonce).await?;
    anyhow::ensure!(
        swapped(&real),
        "control failed: the real keeper should execute the same decision: {}",
        failures(&real)
    );
    run.context(
        "control: the keeper executes the same decision, so the refusals were about the caller",
        json!({"nonce": ready_nonce}),
    );

    run.note(
        "NOT_ALLOWED",
        "the vault never emits NOT_ALLOWED. A #[private] callback called from outside is refused by the \
         SDK with 'Method <name> is private', ft_on_transfer from another contract returns the amount \
         unused, and the keeper methods panic with NOT_KEEPER. SPEC 3.7 and the registry list NOT_ALLOWED \
         next to NOT_KEEPER for this attack",
    );
    run.finish(&env, before, ledger(&env).await?)
}
