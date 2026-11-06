//! Attack Lab, second five attacks (SPEC section 5, S3 and S4): kill-agent, governor-loosen,
//! double-redeem, forged-caller, freeze-race. Same contract as attacks_batch1.rs: each test attacks a
//! sandbox vault, writes `<name>.json` in the proof directory with its verdict and the ledger
//! before and after, and only then asserts, so `tools/attacks/<name>` can tell a breach (exit 1)
//! from a tool error (exit 2). The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as in batch 1.

mod common;

use common::*;
use foundling_sandbox::{event_data, events, failures, Foundling, Setup};
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


/// The function exports of a wasm module, read from its export section.
fn exports(wasm: &[u8]) -> Vec<String> {
    fn leb(bytes: &[u8], pos: &mut usize) -> usize {
        let (mut value, mut shift) = (0usize, 0);
        loop {
            let byte = bytes[*pos];
            *pos += 1;
            value |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                return value;
            }
            shift += 7;
        }
    }
    let mut names = Vec::new();
    let mut pos = 8;
    while pos < wasm.len() {
        let id = wasm[pos];
        pos += 1;
        let size = leb(wasm, &mut pos);
        let end = pos + size;
        if id == 7 {
            for _ in 0..leb(wasm, &mut pos) {
                let len = leb(wasm, &mut pos);
                let name = String::from_utf8_lossy(&wasm[pos..pos + len]).to_string();
                pos += len;
                let kind = wasm[pos];
                pos += 1;
                leb(wasm, &mut pos);
                if kind == 0 {
                    names.push(name);
                }
            }
        }
        pos = end;
    }
    names
}

/// A policy value as a number, whether the vault prints it as a JSON number or as a string.
fn amount(value: &serde_json::Value) -> i128 {
    match value {
        serde_json::Value::String(text) => text.parse().expect("policy amount"),
        other => other.as_i64().expect("policy number") as i128,
    }
}

/// The same kind of value as `like`, holding `number`.
fn as_policy(like: &serde_json::Value, number: i128) -> serde_json::Value {
    match like {
        serde_json::Value::String(_) => json!(number.to_string()),
        _ => json!(number as i64),
    }
}

async fn tighten(
    env: &Foundling,
    who: &Account,
    change: serde_json::Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    env.call_vault(who, "tighten_policy", json!({ "change": change }))
        .await
}

/// SPEC 3.1 and 3.6: the governor can only tighten, never past a floor or ceiling, and cannot
/// add an asset, a route or a strategy. Rotating the keeper takes the timelock and the guardian
/// can cancel it. `open_deposits` only goes from open to closed.
#[tokio::test]
async fn governor_loosen() -> anyhow::Result<()> {
    let env = attack_env_with(Setup {
        open_deposits: true,
        policy: json!({"epoch_len": EPOCH_LEN, "cooldown": COOLDOWN, "timelock": 120}),
        ..Default::default()
    })
    .await?;
    let mut run = Run::new("governor-loosen", &[]);

    // An open vault takes a deposit from an account nobody listed. This is the control for the
    // closing step further down, and it comes before the ledger snapshot because it moves USDC.
    env.register(&env.stranger).await?;
    env.mint(&env.usdc, env.stranger.id(), 10_000_000).await?;
    let deposit = |amount: u128| {
        env.stranger
            .call(env.usdc.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": env.vault_id, "amount": amount.to_string(), "msg": "deposit"}))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
    };
    anyhow::ensure!(deposit(5_000_000).await?.is_success(), "setup failed: the open vault should take a stranger's deposit");
    anyhow::ensure!(
        env.view_vault::<String>("pending_of", json!({"account": env.stranger.id()})).await? == "5000000",
        "setup failed: the deposit should be queued"
    );
    let before = settle_deposit(&env).await?;
    let policy0: serde_json::Value = env.view_vault("policy", json!({})).await?;
    anyhow::ensure!(policy0["open_deposits"] == true, "setup failed: the vault should start open");
    run.context(
        "setup: a vault that starts with open deposits, and an unlisted account already deposited",
        json!({"timelock": policy0["timelock"], "open_deposits": policy0["open_deposits"]}),
    );
    let start = state(&env).await?;

    // 1. Every parameter, moved the wrong way by one unit (or kept the same).
    let tighter_is_lower = [
        "cap_bps", "epoch_cap_bps", "cap_usdc", "epoch_cap_usdc", "cap_wnear", "epoch_cap_wnear",
        "cap_sell_bps", "dust_wnear", "max_risk_bps", "slippage_bps", "price_max_age",
        "price_max_conf_bps", "ref_dev_bps", "ops_budget", "tvl_cap", "per_user_cap", "max_mint_per_cycle",
    ];
    let tighter_is_higher = ["cooldown", "min_deposit"];
    let mut loosened = Vec::new();
    let mut accepted = Vec::new();
    for (field, delta) in tighter_is_lower
        .iter()
        .map(|f| (*f, 1))
        .chain(tighter_is_higher.iter().map(|f| (*f, -1)))
        .chain([("cap_usdc", 0), ("cooldown", 0)])
    {
        let value = as_policy(&policy0[field], amount(&policy0[field]) + delta);
        let result = tighten(&env, &env.governor, json!({ field: value })).await?;
        let text = refused_text(&result);
        match refusal(text.as_deref(), &["POLICY_NOT_TIGHTER"]) {
            Some(_) => loosened.push(format!("{field}{delta:+}")),
            None => accepted.push(json!({"field": field, "delta": delta, "result": text})),
        }
    }
    let now: serde_json::Value = env.view_vault("policy", json!({})).await?;
    run.step(
        "every parameter moved one unit the loosening way, and left unchanged",
        accepted.is_empty() && now == policy0 && state(&env).await? == start,
        None,
        json!({"refused_with": "POLICY_NOT_TIGHTER", "refused": loosened, "accepted": accepted, "policy_unchanged": now == policy0}),
    );

    // 2. Past the floor or ceiling of SPEC 3.6, by one unit.
    let floor = |field: &str, numerator: i128, denominator: i128| {
        as_policy(&policy0[field], amount(&policy0[field]) * numerator / denominator - 1)
    };
    let cooldown_ceiling = amount(&policy0["cooldown"]) * 4 + 1;
    let min_deposit_ceiling = amount(&policy0["min_deposit"]) * 5 + 1;
    let past = [
        ("cap_bps", floor("cap_bps", 1, 10)),
        ("epoch_cap_bps", floor("epoch_cap_bps", 1, 10)),
        ("cap_usdc", floor("cap_usdc", 1, 10)),
        ("epoch_cap_usdc", floor("epoch_cap_usdc", 1, 10)),
        ("cap_wnear", floor("cap_wnear", 1, 10)),
        ("epoch_cap_wnear", floor("epoch_cap_wnear", 1, 10)),
        ("slippage_bps", json!(49)),
        ("price_max_age", json!(29)),
        ("price_max_conf_bps", json!(9)),
        ("ref_dev_bps", json!(49)),
        ("ops_budget", floor("ops_budget", 1, 4)),
        ("cooldown", as_policy(&policy0["cooldown"], cooldown_ceiling)),
        ("min_deposit", as_policy(&policy0["min_deposit"], min_deposit_ceiling)),
    ];
    let mut stopped = Vec::new();
    let mut passed = Vec::new();
    for (field, value) in &past {
        let result = tighten(&env, &env.governor, json!({ *field: value })).await?;
        let text = refused_text(&result);
        match refusal(text.as_deref(), &["POLICY_BELOW_FLOOR"]) {
            Some(_) => stopped.push(json!({"field": field, "value": value})),
            None => passed.push(json!({"field": field, "value": value, "result": text})),
        }
    }
    let now: serde_json::Value = env.view_vault("policy", json!({})).await?;
    run.step(
        "every parameter with a floor or ceiling in SPEC 3.6, one unit past it",
        passed.is_empty() && stopped.len() == past.len() && now == policy0,
        None,
        json!({"refused_with": "POLICY_BELOW_FLOOR", "refused": stopped, "accepted": passed,
               "floors": "caps 10% of initial, cooldown 4x, price_max_age 30, price_max_conf_bps 10, ref_dev_bps 50, slippage_bps 50, ops_budget 25%, min_deposit 5x"}),
    );

    // 3. Fields that are not tightenable at all, and the things the governor must not touch.
    let untouchable = [
        json!({"timelock": 1}), json!({"epoch_len": 99999}), json!({"stuck_after": 1}),
        json!({"halt_after": 1}), json!({"decision_ttl": 1}), json!({"near_reserve": "0"}),
        json!({"max_execution_seconds": 999}),
        json!({"assets": {"usdc": "evil.near", "wnear": "evil.near", "rhea": "evil.near", "pool_id": 1}}),
        json!({"pool_id": 1}), json!({"usdc": "evil.near"}),
        json!({"wasm_hash": "cc", "wasm_url": "https://evil.example/strategy.wasm"}),
        json!({"commitment": "bb"}), json!({"roles": {"governor": env.stranger.id(), "keeper": env.stranger.id(), "guardian": env.stranger.id()}}),
        json!({"keeper": env.stranger.id()}),
    ];
    let mut slipped = Vec::new();
    for change in &untouchable {
        let result = tighten(&env, &env.governor, change.clone()).await?;
        if result.is_success() {
            slipped.push(change.clone());
        }
    }
    run.step(
        "tighten_policy with fields it has no business with: timing, assets, route, strategy, roles",
        slipped.is_empty() && state(&env).await? == start,
        None,
        json!({"attempts": untouchable.len(), "accepted": slipped, "state_unchanged": state(&env).await? == start}),
    );

    // 4. Anyone but the governor.
    let valid = json!({"cap_usdc": as_policy(&policy0["cap_usdc"], amount(&policy0["cap_usdc"]) - 1_000_000)});
    let mut wrong_caller = Vec::new();
    for (who, account) in [("keeper", &env.keeper), ("guardian", &env.guardian), ("stranger", &env.stranger), ("alice", &env.alice)] {
        let result = tighten(&env, account, valid.clone()).await?;
        if refusal(refused_text(&result).as_deref(), &["only governor"]).is_none() {
            wrong_caller.push(who);
        }
    }
    run.step(
        "a valid tightening from the keeper, the guardian and unrelated accounts",
        wrong_caller.is_empty() && state(&env).await? == start,
        None,
        json!({"refused_with": "only governor", "not_refused": wrong_caller}),
    );

    // 5. No loosening method exists, in the deployed code and when called.
    let deployed = env.worker.view_code(&env.vault_id).await?;
    let names = exports(&deployed);
    let governance = ["freeze", "unfreeze", "clear_halt", "tighten_policy", "add_depositor",
        "schedule_keeper_change", "schedule_guardian_change", "cancel_keeper_change", "apply_keeper_change", "apply_guardian_change"];
    let prefixes = ["upgrade", "migrate", "update", "deploy", "set_", "loosen", "raise", "add_asset", "add_route",
        "add_pool", "add_token", "change_", "replace_", "drain", "sweep", "rescue", "emergency", "withdraw_funds", "transfer_funds"];
    let suspicious: Vec<&String> = names.iter().filter(|n| prefixes.iter().any(|p| n.starts_with(p))).collect();
    run.step(
        "the deployed vault exports no upgrade, migrate, set_*, update, add-asset or drain method",
        governance.iter().all(|m| names.contains(&m.to_string())) && suspicious.is_empty(),
        None,
        json!({"exports": names.len(), "governance_methods_present": governance, "suspicious": suspicious,
               "source": "export section of the code deployed in the sandbox"}),
    );
    let keys = env.worker.view_access_keys(&env.vault_id).await?;
    run.step("the vault account has no access key", keys.is_empty(), None, json!({"keys": keys.len()}));

    let nonexistent = [
        "upgrade", "migrate", "update_contract", "deploy_contract", "set_policy", "loosen_policy", "raise_caps", "set_cap",
        "set_caps", "add_asset", "add_route", "add_pool", "set_keeper", "set_guardian", "set_governor", "set_agent",
        "set_strategy", "set_wasm", "set_wasm_hash", "change_strategy", "add_full_access_key", "add_key",
        "withdraw_funds", "drain", "sweep", "transfer_funds", "cancel_guardian_change", "set_open_deposits", "reopen_deposits",
    ];
    let mut found = Vec::new();
    for method in nonexistent {
        let result = env.call_vault(&env.governor, method, json!({})).await?;
        if !refused_text(&result).is_some_and(|t| t.contains("MethodNotFound")) {
            found.push(method);
        }
    }
    run.step(
        "the governor calls each loosening method by name",
        found.is_empty() && state(&env).await? == start,
        None,
        json!({"tried": nonexistent.len(), "refused_with": "MethodNotFound", "answered": found}),
    );

    // 6. open_deposits goes one way.
    let still_open = tighten(&env, &env.governor, json!({"open_deposits": true})).await?;
    run.step(
        "open_deposits: true while it is open",
        refusal(refused_text(&still_open).as_deref(), &["POLICY_NOT_TIGHTER"]).is_some() && state(&env).await? == start,
        None,
        json!({"refused_with": "POLICY_NOT_TIGHTER"}),
    );
    let closed = tighten(&env, &env.governor, json!({"open_deposits": false})).await?;
    anyhow::ensure!(closed.is_success(), "control failed: closing deposits is a tightening: {}", failures(&closed));
    let reopen = tighten(&env, &env.governor, json!({"open_deposits": true})).await?;
    let wallet = wallet_of(&env, &env.usdc, env.stranger.id()).await?;
    let late = deposit(1_000_000).await?;
    anyhow::ensure!(late.is_success(), "ft_transfer_call: {}", failures(&late));
    run.step(
        "open_deposits: true after the governor closed it, and an unlisted deposit afterwards",
        refusal(refused_text(&reopen).as_deref(), &["POLICY_NOT_TIGHTER"]).is_some()
            && env.view_vault::<serde_json::Value>("policy", json!({})).await?["open_deposits"] == false
            && wallet_of(&env, &env.usdc, env.stranger.id()).await? == wallet
            && env.view_vault::<String>("pending_of", json!({"account": env.stranger.id()})).await? == "0",
        None,
        json!({"refused_with": "POLICY_NOT_TIGHTER", "control": "closing succeeded, so the refusal is about the direction",
               "late_deposit": "refunded in full"}),
    );
    let closed_state = state(&env).await?;

    // 7. The keeper changes only on a timer, and the guardian can stop it.
    let by_guardian = env.call_vault(&env.guardian, "schedule_keeper_change", json!({"account": env.stranger.id()})).await?;
    anyhow::ensure!(refusal(refused_text(&by_guardian).as_deref(), &["only governor"]).is_some(), "guardian must not schedule");
    let scheduled = env.call_vault(&env.governor, "schedule_keeper_change", json!({"account": env.stranger.id()})).await?;
    anyhow::ensure!(scheduled.is_success(), "schedule_keeper_change: {}", failures(&scheduled));
    let apply_after = event_data(&scheduled, "keeper_change_scheduled").and_then(|d| d["apply_after"].as_u64()).unwrap_or(0);
    let now_second = head_second(&env).await?;
    let early = env.call_vault(&env.stranger, "apply_keeper_change", json!({})).await?;
    let roles: serde_json::Value = env.view_vault("roles", json!({})).await?;
    run.step(
        "the governor schedules a new keeper, and anyone applies it at once",
        apply_after >= now_second + 100
            && apply_after <= now_second + 120
            && refusal(refused_text(&early).as_deref(), &["TIMELOCK"]).is_some()
            && roles["keeper"] == env.keeper.id().to_string(),
        None,
        json!({"apply_after_minus_now": apply_after.saturating_sub(now_second), "timelock": 120, "refused_with": "TIMELOCK", "keeper_still": roles["keeper"]}),
    );
    let cancelled = env.call_vault(&env.guardian, "cancel_keeper_change", json!({})).await?;
    anyhow::ensure!(cancelled.is_success(), "cancel_keeper_change: {}", failures(&cancelled));
    let gone = env.call_vault(&env.stranger, "apply_keeper_change", json!({})).await?;
    run.step(
        "the guardian cancels the rotation, then someone tries to apply it",
        env.view_vault::<serde_json::Value>("keeper_change", json!({})).await?.is_null()
            && refusal(refused_text(&gone).as_deref(), &["no change scheduled"]).is_some()
            && env.view_vault::<serde_json::Value>("roles", json!({})).await?["keeper"] == env.keeper.id().to_string(),
        None,
        json!({"refused_with": "no change scheduled"}),
    );
    let rescheduled = env.call_vault(&env.governor, "schedule_keeper_change", json!({"account": env.stranger.id()})).await?;
    anyhow::ensure!(rescheduled.is_success(), "{}", failures(&rescheduled));
    wait_seconds(&env, 121).await?;
    let applied = env.call_vault(&env.stranger, "apply_keeper_change", json!({})).await?;
    anyhow::ensure!(applied.is_success(), "control failed: after the timelock the rotation applies: {}", failures(&applied));
    run.context(
        "control: after the timelock the same rotation applies, so the refusals were about the timer",
        json!({"keeper_now": env.view_vault::<serde_json::Value>("roles", json!({})).await?["keeper"]}),
    );

    // 8. Repeated small cuts walk down to the floor of the initial value and stop there.
    let initial = amount(&policy0["cap_usdc"]);
    let mut walk = Vec::new();
    for target in [initial * 8 / 15, initial * 4 / 15, initial * 2 / 15, initial / 10] {
        let result = tighten(&env, &env.governor, json!({"cap_usdc": as_policy(&policy0["cap_usdc"], target)})).await?;
        walk.push(result.is_success());
    }
    let below = tighten(&env, &env.governor, json!({"cap_usdc": as_policy(&policy0["cap_usdc"], initial / 10 - 1)})).await?;
    let again = tighten(&env, &env.governor, json!({"cap_usdc": as_policy(&policy0["cap_usdc"], initial / 10)})).await?;
    let final_policy: serde_json::Value = env.view_vault("policy", json!({})).await?;
    run.step(
        "four cuts down to 10% of the initial cap_usdc are accepted, one unit below and a repeat are not",
        walk.iter().all(|ok| *ok)
            && refusal(refused_text(&below).as_deref(), &["POLICY_BELOW_FLOOR"]).is_some()
            && refusal(refused_text(&again).as_deref(), &["POLICY_NOT_TIGHTER"]).is_some()
            && amount(&final_policy["cap_usdc"]) == initial / 10,
        None,
        json!({"initial": initial.to_string(), "final": final_policy["cap_usdc"], "walk_accepted": walk}),
    );

    anyhow::ensure!(
        closed_state["book"] == start["book"] && closed_state["total_shares"] == start["total_shares"],
        "the book moved"
    );
    run.finish(&env, before, ledger(&env).await?)
}
