//! Attack Lab, last five attacks (SPEC section 5): inflated-nav, deflated-sell, never-flat, setup-spam,
//! advance-race. Same contract as batch 1 and 2: each test attacks a sandbox vault, writes
//! `<name>.json` in the proof directory with its verdict and the ledger before and after, and only
//! then asserts, so `tools/attacks/<name>` can tell a breach (exit 1) from a tool error (exit 2).
//! The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as before.

mod common;

use common::*;
use foundling_sandbox::{event_data, events, failures, Foundling, Setup, NEAR_FEED, NEAR_PRICE};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// What the vault's NAV rests on: the books and shares, and what it holds at Ref. Wallets are left
/// out because a donation legitimately changes them.
async fn books(env: &Foundling) -> anyhow::Result<Value> {
    Ok(json!({
        "book": env.view_vault::<Value>("book", json!({})).await?,
        "total_shares": env.view_vault::<String>("total_shares", json!({})).await?,
        "rhea_book": env.view_vault::<Value>("rhea_book", json!({})).await?,
    }))
}

/// Tells the mock oracle what NEAR/USD is now, with eight decimals.
async fn set_near_price(env: &Foundling, price: u128) -> anyhow::Result<()> {
    let result = env
        .parent
        .call(env.oracle.id(), "set_feed")
        .args_json(json!({
            "price_id": NEAR_FEED,
            "feed": {"price": price.to_string(), "conf": "10000", "expo": -8, "lag_seconds": 0},
        }))
        .transact()
        .await?;
    anyhow::ensure!(result.is_success(), "set_feed: {}", failures(&result));
    Ok(())
}

/// A decision whose `ref_price` agrees with the price the oracle now reports, as a strategy that
/// reads the same feed would write it; the vault checks the two against each other.
fn priced(action: &str, amount_in: u128, price: u128) -> Value {
    let mut decision = template(action, amount_in);
    decision["ref_price"] = json!(price.to_string());
    decision
}

fn policy_amount(policy: &Value, field: &str) -> anyhow::Result<u128> {
    Ok(policy[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("policy has no {field}: {policy}"))?
        .parse()?)
}

/// Sends `amount` of USDC straight to the vault's wallet, as anyone can.
async fn donate_usdc(env: &Foundling, amount: u128) -> anyhow::Result<()> {
    env.mint(&env.usdc, env.stranger.id(), amount).await?;
    let sent = env
        .stranger
        .call(env.usdc.id(), "ft_transfer")
        .args_json(json!({"receiver_id": env.vault_id, "amount": amount.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(sent.is_success(), "ft_transfer: {}", failures(&sent));
    Ok(())
}

/// I13: the absolute cap per token in holds whatever the NAV says. The buy cap is the smaller of
/// `cap_bps` of NAV and `cap_usdc`, and NAV counts the wNEAR book at the anchor price, so a price
/// 100 times too high lifts the bps line past the absolute one. Donations never reach the NAV: the
/// books move only on returned values (I8).
#[tokio::test]
async fn inflated_nav() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("inflated-nav", &["OVER_ABS_CAP"]);
    settle_deposit(&env).await?;
    let bought = decide(&env, template("buy_risk", DEPOSIT / 10)).await?;
    anyhow::ensure!(
        bought.started,
        "setup failed: a buy at the bps cap should trade: {bought:?}"
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    let policy: Value = env.view_vault("policy", json!({})).await?;
    let cap_usdc = policy_amount(&policy, "cap_usdc")?;
    let cap_bps = policy["cap_bps"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("policy has no cap_bps"))? as u128;
    let (usdc_book, wnear_book) = book(&env).await?;
    let before = ledger(&env).await?;
    let start = books(&env).await?;
    // wNEAR has 24 decimals and USDC 6, the price 8: value in USDC units = book * price / 10^26.
    let nav_at = |price: u128| usdc_book + wnear_book * price / 10u128.pow(26);
    let one_over = cap_usdc + 1;
    run.context(
        "setup: the vault holds USDC and wNEAR, and the buy is one unit over the absolute cap",
        json!({"cap_usdc": cap_usdc.to_string(), "cap_bps": cap_bps.to_string(), "usdc_book": usdc_book.to_string(),
               "wnear_book": wnear_book.to_string(), "buy": one_over.to_string()}),
    );

    // Control: at the honest price the bps cap binds long before the absolute one.
    let honest = decide(&env, priced("buy_risk", one_over, NEAR_PRICE)).await?;
    anyhow::ensure!(
        honest.rejected.as_deref() == Some("OVER_CAP") && !honest.started,
        "control failed: at the honest price the bps cap should refuse: {honest:?}"
    );
    run.context(
        "control: at the honest price the same buy is refused by the bps cap, not the absolute cap",
        json!({"nonce": honest.nonce, "refused_with": "OVER_CAP", "bps_cap": (nav_at(NEAR_PRICE) * cap_bps / 10_000).to_string()}),
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    // A donation of 1,000 USDC is not NAV.
    let wallet_before = wallet_of(&env, &env.usdc, &env.vault_id).await?;
    donate_usdc(&env, 1_000_000_000).await?;
    let donated = wallet_of(&env, &env.usdc, &env.vault_id).await? - wallet_before;
    let after_gift = decide(&env, priced("buy_risk", one_over, NEAR_PRICE)).await?;
    run.step(
        "1,000 USDC sent straight to the vault: the books and the bps cap do not move",
        donated == 1_000_000_000
            && books(&env).await? == start
            && after_gift.rejected.as_deref() == Some("OVER_CAP")
            && !after_gift.started,
        None,
        json!({"donated": donated.to_string(), "refused_with": after_gift.rejected, "books_unchanged": books(&env).await? == start}),
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    // The price, inflated: the bps line climbs, the absolute line does not.
    for factor in [2u128, 10] {
        let price = NEAR_PRICE * factor;
        set_near_price(&env, price).await?;
        let outcome = decide(&env, priced("buy_risk", one_over, price)).await?;
        run.step(
            &format!("anchor price {factor}x: the bps cap still binds"),
            outcome.rejected.as_deref() == Some("OVER_CAP") && !outcome.started && books(&env).await? == start,
            None,
            json!({"nav": nav_at(price).to_string(), "bps_cap": (nav_at(price) * cap_bps / 10_000).to_string(),
                   "refused_with": outcome.rejected}),
        );
        wait_seconds(&env, COOLDOWN + 1).await?;
    }

    let price = NEAR_PRICE * 100;
    set_near_price(&env, price).await?;
    anyhow::ensure!(
        nav_at(price) * cap_bps / 10_000 > cap_usdc,
        "setup failed: a price 100x too high should lift the bps cap past the absolute cap"
    );
    run.context(
        "the anchor price is 100x: the bps cap now sits above the absolute cap",
        json!({"nav": nav_at(price).to_string(), "bps_cap": (nav_at(price) * cap_bps / 10_000).to_string(), "cap_usdc": cap_usdc.to_string()}),
    );
    // Both amounts are under the bps line and over the absolute one, so only the absolute cap can say no.
    let bps_line = nav_at(price) * cap_bps / 10_000;
    for amount in [one_over, (cap_usdc + bps_line) / 2] {
        let outcome = decide(&env, priced("buy_risk", amount, price)).await?;
        run.step(
            &format!("anchor price 100x, buy of {amount}: the absolute cap refuses"),
            outcome.rejected.as_deref() == Some("OVER_ABS_CAP") && !outcome.started && books(&env).await? == start,
            outcome.rejected.as_deref(),
            json!({"amount_in": amount.to_string(), "nonce": outcome.nonce, "books_unchanged": books(&env).await? == start}),
        );
        wait_seconds(&env, COOLDOWN + 1).await?;
    }
    run.step(
        "after the series the vault is Idle with the books it started with",
        stage(&env).await? == json!("Idle") && books(&env).await? == start,
        None,
        json!({}),
    );
    run.note(
        "LEDGER",
        "ledger_after differs from ledger_before by the 1,000 USDC donated to the vault's wallet; the books, shares and Ref ledger are equal, which each step asserts",
    );
    run.finish(&env, before, ledger(&env).await?)
}

const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// A sell has no price in it: its caps are in wNEAR, the smaller of `cap_wnear` and `cap_sell_bps`
/// of the wNEAR book (a book at or under `cap_wnear` may be swept whole). So lowering the anchor
/// price cannot make the vault sell more. The same sell is refused at the honest price, at a tenth
/// and at a hundredth of it, first with the bps line binding and then, after the governor tightens
/// `cap_wnear`, with the absolute one. A sell exactly at the cap still goes through, and moves no more.
#[tokio::test]
async fn deflated_sell() -> anyhow::Result<()> {
    let env = attack_env_with(Setup {
        policy: json!({
            "epoch_len": EPOCH_LEN, "cooldown": COOLDOWN,
            "cap_wnear": (3 * WNEAR / 10).to_string(), "epoch_cap_wnear": WNEAR.to_string(),
        }),
        ..Default::default()
    })
    .await?;
    let mut run = Run::new("deflated-sell", &["OVER_ABS_CAP"]);
    settle_deposit(&env).await?;
    let bought = decide(&env, template("buy_risk", DEPOSIT / 10)).await?;
    anyhow::ensure!(
        bought.started,
        "setup failed: the buy should trade: {bought:?}"
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    let policy: Value = env.view_vault("policy", json!({})).await?;
    let cap_sell_bps = policy["cap_sell_bps"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("policy has no cap_sell_bps"))?
        as u128;
    let cap_wnear = policy_amount(&policy, "cap_wnear")?;
    let (_, wnear_book) = book(&env).await?;
    let bps_line = wnear_book * cap_sell_bps / 10_000;
    anyhow::ensure!(
        wnear_book > cap_wnear && bps_line < cap_wnear,
        "setup failed: the book should be over cap_wnear with the bps line under it: {wnear_book} {cap_wnear} {bps_line}"
    );
    let before = ledger(&env).await?;
    let start = books(&env).await?;
    // Over the bps line and under the absolute cap: only cap_sell_bps can refuse it.
    let over_bps = (bps_line + cap_wnear) / 2;
    run.context(
        "setup: the wNEAR book is over cap_wnear and the bps line is the lower one",
        json!({"wnear_book": wnear_book.to_string(), "cap_wnear": cap_wnear.to_string(), "bps_line": bps_line.to_string(), "sell": over_bps.to_string()}),
    );

    for divisor in [1u128, 10, 100] {
        let price = NEAR_PRICE / divisor;
        set_near_price(&env, price).await?;
        let outcome = decide(&env, priced("sell_risk", over_bps, price)).await?;
        run.step(
            &format!("anchor price 1/{divisor}, sell over cap_sell_bps of the book"),
            outcome.rejected.as_deref() == Some("OVER_ABS_CAP") && !outcome.started && books(&env).await? == start,
            outcome.rejected.as_deref(),
            json!({"price": price.to_string(), "amount_in": over_bps.to_string(), "nonce": outcome.nonce, "books_unchanged": books(&env).await? == start}),
        );
        wait_seconds(&env, COOLDOWN + 1).await?;
    }

    // The governor tightens cap_wnear under the bps line, so the absolute cap is the one that binds.
    let tight = cap_wnear / 3;
    let tightened = env
        .call_vault(
            &env.governor,
            "tighten_policy",
            json!({"change": {"cap_wnear": tight.to_string()}}),
        )
        .await?;
    anyhow::ensure!(
        tightened.is_success(),
        "tighten_policy: {}",
        failures(&tightened)
    );
    let between = (tight + bps_line) / 2;
    let price = NEAR_PRICE / 100;
    anyhow::ensure!(
        between > tight && between < bps_line,
        "setup failed: the sell should sit between the two lines"
    );
    run.context(
        "the governor tightens cap_wnear under the bps line",
        json!({"cap_wnear": tight.to_string(), "bps_line": bps_line.to_string(), "sell": between.to_string()}),
    );
    let outcome = decide(&env, priced("sell_risk", between, price)).await?;
    run.step(
        "anchor price 1/100, sell over cap_wnear and under the bps line",
        outcome.rejected.as_deref() == Some("OVER_ABS_CAP") && !outcome.started && books(&env).await? == start,
        outcome.rejected.as_deref(),
        json!({"amount_in": between.to_string(), "cap_wnear": tight.to_string(), "nonce": outcome.nonce, "books_unchanged": books(&env).await? == start}),
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    // Control: exactly cap_wnear trades, so the line is the cap itself, and the swap moves that much and no more.
    let (usdc_before, wnear_before) = book(&env).await?;
    let at_cap = priced("sell_risk", tight, price);
    env.set_next(json!({"Decision": {"template": at_cap}}))
        .await?;
    let triggered = env.trigger_cycle().await?;
    anyhow::ensure!(
        triggered.is_success(),
        "trigger_cycle: {}",
        failures(&triggered)
    );
    let nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    let sold = execute(&env, nonce).await?;
    let sold_amount = event_data(&sold, "swap_started").map(|data| data["amount_in"].clone());
    anyhow::ensure!(
        swapped(&sold) && sold_amount == Some(json!(tight.to_string())),
        "control failed: exactly cap_wnear should trade: {}",
        failures(&sold)
    );
    let (usdc_after, wnear_after) = book(&env).await?;
    run.step(
        "control: a sell of exactly cap_wnear at 1/100 of the price goes through, and the wNEAR book falls by that much only",
        delta(wnear_before, wnear_after) == -(tight as i128) && delta(usdc_before, usdc_after) > 0,
        None,
        json!({"amount_in": tight.to_string(), "wnear_book_drop": (-delta(wnear_before, wnear_after)).to_string(),
               "usdc_book_gain": delta(usdc_before, usdc_after).to_string()}),
    );
    run.note(
        "LEDGER",
        "ledger_after differs from ledger_before by the one control sell at the cap; every refused sell asserts the books, shares and Ref ledger unchanged",
    );
    run.finish(&env, before, ledger(&env).await?)
}

async fn pending_of(env: &Foundling, who: &near_workspaces::Account) -> anyhow::Result<u128> {
    let pending: String = env
        .view_vault("pending_of", json!({"account": who.id()}))
        .await?;
    Ok(pending.parse()?)
}

/// Shares are minted only while the vault is flat (`wnear_book` at or under `dust_wnear`), and they
/// are minted without a price. The risk: the wNEAR book can only be sold down by `cap_sell_bps` of
/// itself per decision, so if it never reached flat the queue would wait for ever. A book at or under
/// `cap_wnear` may be swept whole, which is what lets it get there. The vault sells down in capped
/// steps (the lowest cap each time), the deposit queued meanwhile stays queued, and the next cycle
/// after the vault is flat mints it, at a price that does not dilute the holder before.
#[tokio::test]
async fn never_flat() -> anyhow::Result<()> {
    const NEW_DEPOSIT: u128 = 5_000_000;
    let env = attack_env_with(Setup {
        open_deposits: true,
        policy: json!({
            "epoch_len": EPOCH_LEN, "cooldown": COOLDOWN,
            "cap_wnear": (WNEAR / 10).to_string(), "epoch_cap_wnear": (WNEAR / 2).to_string(),
        }),
        ..Default::default()
    })
    .await?;
    let mut run = Run::new("never-flat", &[]);
    settle_deposit(&env).await?;
    let bought = decide(&env, template("buy_risk", DEPOSIT / 10)).await?;
    anyhow::ensure!(
        bought.started,
        "setup failed: the buy should trade: {bought:?}"
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    let policy: Value = env.view_vault("policy", json!({})).await?;
    let dust = policy_amount(&policy, "dust_wnear")?;
    let cap_wnear = policy_amount(&policy, "cap_wnear")?;
    let cap_sell_bps = policy["cap_sell_bps"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("policy has no cap_sell_bps"))?
        as u128;
    let (_, wnear_book) = book(&env).await?;
    anyhow::ensure!(
        wnear_book > dust,
        "setup failed: the vault should hold wNEAR"
    );

    // A new depositor queues USDC while the vault holds wNEAR.
    env.register(&env.stranger).await?;
    env.mint(&env.usdc, env.stranger.id(), NEW_DEPOSIT).await?;
    let queued = env
        .stranger
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": env.vault_id, "amount": NEW_DEPOSIT.to_string(), "msg": "deposit"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(queued.is_success(), "deposit: {}", failures(&queued));
    anyhow::ensure!(
        pending_of(&env, &env.stranger).await? == NEW_DEPOSIT,
        "setup failed: the deposit should be queued"
    );
    let before = ledger(&env).await?;
    let total_before = total_shares(&env).await?;
    run.context(
        "setup: the vault holds wNEAR and a new depositor's USDC is queued",
        json!({"wnear_book": wnear_book.to_string(), "dust_wnear": dust.to_string(), "queued": NEW_DEPOSIT.to_string()}),
    );

    let held = decide(&env, template("none", 0)).await?;
    anyhow::ensure!(
        held.rejected.is_none() && held.failed.is_none() && !held.started,
        "{held:?}"
    );
    run.step(
        "a cycle while the vault holds wNEAR does not mint the queue",
        pending_of(&env, &env.stranger).await? == NEW_DEPOSIT
            && shares_of(&env, &env.stranger).await? == 0
            && total_shares(&env).await? == total_before,
        None,
        json!({"pending": NEW_DEPOSIT.to_string(), "shares": "0"}),
    );
    wait_seconds(&env, COOLDOWN + 1).await?;

    // Sell down in capped steps: each one the lowest of cap_wnear and cap_sell_bps of the book; once
    // the book is at or under cap_wnear, sweep all but half the dust.
    let mut sells = Vec::new();
    for _ in 0..12 {
        let (_, current) = book(&env).await?;
        if current <= dust {
            break;
        }
        let amount = if current <= cap_wnear {
            current - dust / 2
        } else {
            cap_wnear.min(current * cap_sell_bps / 10_000)
        };
        let outcome = decide(&env, template("sell_risk", amount)).await?;
        anyhow::ensure!(
            outcome.started && outcome.rejected.is_none(),
            "a sell at the limit should trade, so the book can reach flat: {outcome:?} (book {current}, amount {amount})"
        );
        let (_, after) = book(&env).await?;
        sells.push(json!({"amount_in": amount.to_string(), "book_before": current.to_string(), "book_after": after.to_string()}));
        wait_seconds(&env, COOLDOWN + 1).await?;
    }
    let (usdc_flat, wnear_flat) = book(&env).await?;
    run.step(
        "capped sells bring the wNEAR book to or under the dust line",
        wnear_flat <= dust && wnear_flat > 0,
        None,
        json!({"sells": sells, "wnear_book": wnear_flat.to_string(), "dust_wnear": dust.to_string()}),
    );

    // The next cycle mints the queue.
    let price_before_book = usdc_flat;
    let shares_at_flat = total_shares(&env).await?;
    let minted_cycle = decide(&env, template("none", 0)).await?;
    anyhow::ensure!(
        minted_cycle.rejected.is_none() && minted_cycle.failed.is_none(),
        "{minted_cycle:?}"
    );
    let new_shares = shares_of(&env, &env.stranger).await?;
    let (usdc_after, _) = book(&env).await?;
    let total_after = total_shares(&env).await?;
    run.step(
        "the next cycle, with the vault flat, mints the queued deposit",
        pending_of(&env, &env.stranger).await? == 0
            && new_shares > 0
            && total_after == shares_at_flat + new_shares
            && delta(usdc_flat, usdc_after) == NEW_DEPOSIT as i128,
        None,
        json!({"new_shares": new_shares.to_string(), "usdc_book_gain": delta(usdc_flat, usdc_after).to_string()}),
    );
    // The share price must not fall: book / shares after is at least book / shares before.
    run.step(
        "the mint does not dilute the holder before: the USDC book per share did not fall",
        usdc_after * shares_at_flat >= price_before_book * total_after,
        None,
        json!({"book_before": price_before_book.to_string(), "shares_before": shares_at_flat.to_string(),
               "book_after": usdc_after.to_string(), "shares_after": total_after.to_string()}),
    );
    run.step(
        "the new depositor's shares are worth no more than what was deposited",
        new_shares * usdc_after / total_after <= NEW_DEPOSIT,
        None,
        json!({"value": (new_shares * usdc_after / total_after).to_string(), "deposited": NEW_DEPOSIT.to_string()}),
    );
    run.note(
        "LEDGER",
        "ledger_after differs from ledger_before by the sells and the mint; each step asserts what it claims",
    );
    run.finish(&env, before, ledger(&env).await?)
}

const TARGETS: [&str; 4] = ["Usdc", "Wnear", "Rhea", "RheaTokens"];
/// What `setup_storage` pays per target (setup.rs): the two token registrations, the Ref storage
/// deposit, and one yoctoNEAR for `register_tokens`.
const TOKEN_STORAGE: u128 = 1_250_000_000_000_000_000_000;
const REF_STORAGE: u128 = 10_000_000_000_000_000_000_000;
/// The protocol's price of a stored byte.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

type Calls = Vec<(&'static str, near_workspaces::result::ExecutionFinalResult)>;

async fn spam_accounts(
    env: &Foundling,
    count: usize,
) -> anyhow::Result<Vec<near_workspaces::Account>> {
    let root = env.worker.root_account()?;
    let mut accounts = Vec::new();
    for index in 0..count {
        accounts.push(
            root.create_subaccount(&format!("spam{index}"))
                .initial_balance(NearToken::from_near(2))
                .transact()
                .await?
                .into_result()?,
        );
    }
    Ok(accounts)
}

/// Every account calls `setup_storage` `per_account` times, all accounts at once. Each account
/// signs its own calls one after the other, so the vault sees as many in flight as there are accounts.
async fn barrage(
    env: &Foundling,
    accounts: &[near_workspaces::Account],
    per_account: usize,
    targets: &[&'static str],
) -> anyhow::Result<Calls> {
    let mut set = tokio::task::JoinSet::new();
    for (index, account) in accounts.iter().enumerate() {
        let account = account.clone();
        let vault = env.vault_id.clone();
        let picks: Vec<&'static str> = (0..per_account)
            .map(|call| targets[(index + call) % targets.len()])
            .collect();
        set.spawn(async move {
            let mut done: Calls = Vec::new();
            for target in picks {
                let result = account
                    .call(&vault, "setup_storage")
                    .args_json(json!({ "target": target }))
                    .max_gas()
                    .transact()
                    .await?;
                done.push((target, result));
            }
            anyhow::Ok(done)
        });
    }
    let mut calls = Vec::new();
    while let Some(joined) = set.join_next().await {
        calls.extend(joined??);
    }
    Ok(calls)
}

/// How many registrations of `target` actually completed: `on_setup` logs `setup_step` with
/// `failed` false once the registration call came back.
fn completed(calls: &Calls, target: &str) -> usize {
    calls
        .iter()
        .filter(|(called, _)| *called == target)
        .flat_map(|(_, result)| events(result))
        .filter(|event| event["event"] == "setup_step" && event["data"][0]["failed"] == false)
        .count()
}

async fn vault_near(env: &Foundling) -> anyhow::Result<(u128, u128)> {
    let details = env.worker.view_account(&env.vault_id).await?;
    Ok((
        details.balance.as_yoctonear(),
        details.storage_usage as u128,
    ))
}

/// `setup_storage` is open to everyone and pays from the vault's own NEAR, so a crowd could try to
/// register the same target over and over (Ref's storage surplus cannot be withdrawn again) or run
/// the vault's NEAR down until a state write, `redeem` included, fails (I11). The flag goes in before
/// the promise: one call per target gets through, and the NEAR floor (`stake + near_reserve`) holds.
/// First with plenty of NEAR, where every target is registered exactly once; then with a reserve
/// that leaves room for the two token registrations only, where Ref's 0.01 NEAR must be refused.
#[tokio::test]
async fn setup_spam() -> anyhow::Result<()> {
    let mut run = Run::new("setup-spam", &["NEAR_RESERVE"]);

    // A. Plenty of NEAR: 100 calls from 25 accounts, then ten more for RheaTokens, which waits for Ref.
    let env = Foundling::start().await?;
    let (near_before, _) = vault_near(&env).await?;
    let accounts = spam_accounts(&env, 25).await?;
    let mut calls = barrage(&env, &accounts, 4, &TARGETS).await?;
    anyhow::ensure!(
        calls.len() == 100,
        "setup failed: the barrage should be 100 calls"
    );
    if completed(&calls, "Rhea") == 1 && completed(&calls, "RheaTokens") == 0 {
        calls.extend(barrage(&env, &accounts[..10], 1, &["RheaTokens"]).await?);
    }
    let mut refused = 0;
    for (_, result) in &calls {
        if run.refused(result).is_some() {
            refused += 1;
        }
    }
    let per_target: Vec<usize> = TARGETS
        .iter()
        .map(|target| completed(&calls, target))
        .collect();
    let (near_after, _) = vault_near(&env).await?;
    let fixed = 2 * TOKEN_STORAGE + REF_STORAGE + 1;
    run.step(
        "100 simultaneous setup_storage calls: each target is registered exactly once",
        per_target == [1, 1, 1, 1]
            && env.view_vault::<bool>("is_setup_done", json!({})).await?
            && refused == calls.len() - 4,
        None,
        json!({"calls": calls.len(), "completed_per_target": per_target, "refused": refused,
               "targets": TARGETS}),
    );
    run.step(
        "the NEAR the vault paid is the four registrations and not more",
        delta(near_before, near_after) <= 0 && (near_before - near_after) <= fixed + NEAR / 100,
        None,
        json!({"paid": (near_before.saturating_sub(near_after)).to_string(), "registrations": fixed.to_string(),
               "margin": (NEAR / 100).to_string()}),
    );

    // B. A reserve that leaves room for the two token registrations (0.0025 NEAR) and not for Ref (0.01).
    // The first vault, as deployed, tells what a second one will hold: its NEAR before anything was
    // spent, and the bytes it stores (setup does not change the size of its state).
    let (_, usage) = vault_near(&env).await?;
    let room = 5 * NEAR / 1000;
    let reserve = near_before - usage * BYTE_COST - room;
    let tight = Foundling::start_with(Setup {
        policy: json!({ "near_reserve": reserve.to_string() }),
        ..Default::default()
    })
    .await?;
    let (tight_before, _) = vault_near(&tight).await?;
    let accounts = spam_accounts(&tight, 25).await?;
    let calls = barrage(&tight, &accounts, 4, &TARGETS).await?;
    let mut ref_refusals = 0;
    for (target, result) in &calls {
        if let Some(text) = run.refused(result) {
            if *target == "Rhea" && text.contains("NEAR_RESERVE") {
                ref_refusals += 1;
            }
        }
    }
    let per_target: Vec<usize> = TARGETS
        .iter()
        .map(|target| completed(&calls, target))
        .collect();
    let (tight_after, tight_usage) = vault_near(&tight).await?;
    let floor = tight_usage * BYTE_COST + reserve;
    run.step(
        "with room for two token registrations only, Ref's storage deposit is refused with NEAR_RESERVE every time",
        per_target == [1, 1, 0, 0] && ref_refusals > 0 && !tight.view_vault::<bool>("is_setup_done", json!({})).await?,
        Some("NEAR_RESERVE"),
        json!({"completed_per_target": per_target, "rhea_refused_near_reserve": ref_refusals}),
    );
    run.step(
        "the vault's NEAR never fell under stake + near_reserve",
        tight_after >= floor && delta(tight_before, tight_after) < 0,
        None,
        json!({"balance_before": tight_before.to_string(), "balance_after": tight_after.to_string(),
               "floor": floor.to_string(), "near_reserve": reserve.to_string(), "stake": (tight_usage * BYTE_COST).to_string()}),
    );
    run.finish(
        &env,
        json!({"vault_near": near_before.to_string()}),
        json!({"vault_near": near_after.to_string()}),
    )
}

/// What Ref says the vault holds there, as (USDC, wNEAR).
async fn rhea_holds(env: &Foundling) -> anyhow::Result<(u128, u128)> {
    let mut held = Vec::new();
    for token in [&env.usdc, &env.wnear] {
        let amount: String = env
            .view_contract(
                &env.rhea,
                "get_deposit",
                json!({"account_id": env.vault_id, "token_id": token.id()}),
            )
            .await?;
        held.push(amount.parse::<u128>()?);
    }
    Ok((held[0], held[1]))
}

/// What the vault thinks it holds at Ref (`rhea_bal`), as (USDC, wNEAR).
async fn rhea_ledger(env: &Foundling) -> anyhow::Result<(u128, u128)> {
    let ledger: Value = env.view_vault("rhea_book", json!({})).await?;
    let amount = |token: &str| -> anyhow::Result<u128> {
        Ok(ledger[token]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("rhea_book has no {token}: {ledger}"))?
            .parse()?)
    };
    Ok((amount("usdc")?, amount("wnear")?))
}

/// Anyone can credit the vault's account at Ref with `mft_transfer`: put `amount` of USDC in Ref
/// under `stranger` first, then give it to the vault.
async fn donate_at_rhea(env: &Foundling, amount: u128) -> anyhow::Result<()> {
    env.mint(&env.usdc, env.stranger.id(), amount).await?;
    let funded = env
        .stranger
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": env.rhea.id(), "amount": amount.to_string(), "msg": ""}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(funded.is_success(), "funding Ref: {}", failures(&funded));
    let given = env
        .stranger
        .call(env.rhea.id(), "mft_transfer")
        .args_json(json!({"token_id": env.usdc.id(), "receiver_id": env.vault_id, "amount": amount.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(given.is_success(), "mft_transfer: {}", failures(&given));
    Ok(())
}

/// `advance` is open to everyone and marks `Probing` before it reads Ref, so a second call finds a
/// stage that is neither `Stuck` nor timed out and is refused: one retry per stall, not one per
/// caller. First five accounts call it on one stuck swap at once. Then a swap whose real answer is
/// still in flight: an `advance` before `stuck_after` is refused, one after it recovers the swap,
/// and the late original callback finds another attempt and does nothing. Ref's balance matches the
/// vault's ledger throughout, apart from what a donation added there, which never reaches the books.
#[tokio::test]
async fn advance_race() -> anyhow::Result<()> {
    let mut run = Run::new("advance-race", &["NOT_STUCK"]);

    // A. A swap stuck at its swap step, and five accounts advancing it at once.
    let env = attack_env(testnet_timing()).await?;
    settle_deposit(&env).await?;
    let before = ledger(&env).await?;
    let idle_books = books(&env).await?;
    let idle_wallet = wallet_of(&env, &env.usdc, &env.vault_id).await?;
    set_fault(&env, "SwapGarbageNotApplied").await?;
    let nonce = decision_ready(&env, template("buy_risk", 1_000_000)).await?;
    let started = execute(&env, nonce).await?;
    anyhow::ensure!(
        started.is_success(),
        "execute_decision: {}",
        failures(&started)
    );
    anyhow::ensure!(
        stage(&env).await?["Stuck"]["step"] == "Swap",
        "setup failed: the swap should be stuck: {}",
        stage(&env).await?
    );
    let (ledger_usdc, ledger_wnear) = rhea_ledger(&env).await?;
    anyhow::ensure!(
        (ledger_usdc, ledger_wnear) == (1_000_000, 0) && rhea_holds(&env).await? == (1_000_000, 0),
        "setup failed: Ref and the ledger should both hold the 1 USDC that went in"
    );
    run.context(
        "setup: a buy is stuck at the swap step, and Ref's balance equals the vault's ledger",
        json!({"nonce": nonce, "in_ref": "1000000", "ledger": "1000000"}),
    );
    let flight_books = books(&env).await?;

    donate_at_rhea(&env, 3_000_000).await?;
    run.step(
        "3 USDC given to the vault's account at Ref while the swap is stuck: the books and the ledger do not move",
        books(&env).await? == flight_books
            && rhea_ledger(&env).await? == (1_000_000, 0)
            && rhea_holds(&env).await? == (4_000_000, 0),
        None,
        json!({"in_ref": "4000000", "ledger": "1000000", "books_unchanged": books(&env).await? == flight_books}),
    );

    let racers = [
        &env.stranger,
        &env.alice,
        &env.governor,
        &env.guardian,
        &env.keeper,
    ];
    let mut pending = Vec::new();
    for account in racers {
        pending.push(
            account
                .call(&env.vault_id, "advance")
                .args_json(json!({ "nonce": nonce }))
                .max_gas()
                .transact_async()
                .await?,
        );
    }
    let mut results = Vec::new();
    for status in pending {
        results.push(status.await?);
    }
    let wins = results.iter().filter(|result| result.is_success()).count();
    let mut losers_say_not_stuck = 0;
    for result in &results {
        if let Some(text) = run.refused(result) {
            if refusal(Some(&text), &["NOT_STUCK"]).is_some() {
                losers_say_not_stuck += 1;
            }
        }
    }
    let probing: usize = results
        .iter()
        .map(|result| event_count(result, "probing"))
        .sum();
    let reverted: usize = results
        .iter()
        .map(|result| event_count(result, "swap_reverted"))
        .sum();
    run.step(
        "five advances at once on one stuck swap: one goes through, the other four read NOT_STUCK",
        wins == 1 && probing == 1 && reverted == 1 && losers_say_not_stuck == 4,
        Some("NOT_STUCK"),
        json!({"callers": 5, "succeeded": wins, "probing_events": probing, "swap_reverted_events": reverted,
               "refused_not_stuck": losers_say_not_stuck}),
    );
    let (held_usdc, held_wnear) = rhea_holds(&env).await?;
    run.step(
        "afterwards the vault is Idle with the books it had, and Ref holds the ledger plus the donation only",
        stage(&env).await? == json!("Idle")
            && books(&env).await? == idle_books
            && rhea_ledger(&env).await? == (0, 0)
            && (held_usdc, held_wnear) == (3_000_000, 0)
            && wallet_of(&env, &env.usdc, &env.vault_id).await? == idle_wallet,
        None,
        json!({"in_ref": held_usdc.to_string(), "ledger": "0", "donation": "3000000", "books_unchanged": books(&env).await? == idle_books}),
    );

    // B. A swap whose real answer is still in flight (Ref's answer comes about 200 blocks late).
    let slow = attack_env_with(Setup {
        policy: json!({"epoch_len": EPOCH_LEN, "cooldown": COOLDOWN, "stuck_after": 10, "halt_after": 600}),
        ..Default::default()
    })
    .await?;
    settle_deposit(&slow).await?;
    let slow_before = books(&slow).await?;
    let (usdc_book, wnear_book) = book(&slow).await?;
    set_fault(&slow, "SwapHang").await?;
    let hung_nonce = decision_ready(&slow, template("buy_risk", 1_000_000)).await?;
    let running = slow
        .keeper
        .call(&slow.vault_id, "execute_decision")
        .args_json(json!({ "nonce": hung_nonce }))
        .max_gas()
        .transact_async()
        .await?;
    wait_for_stage(&slow, "Swapping").await?;
    let early = slow
        .call_vault(&slow.stranger, "advance", json!({"nonce": hung_nonce}))
        .await?;
    let early_text = run.refused(&early);
    run.step(
        "advance while the real answer is in flight and stuck_after has not passed",
        refusal(early_text.as_deref(), &["NOT_STUCK"]).is_some()
            && has_stage(&slow, "Swapping").await?,
        Some("NOT_STUCK"),
        json!({"stage": "Swapping"}),
    );
    wait_seconds(&slow, 11).await?;
    let rescue = slow
        .call_vault(&slow.stranger, "advance", json!({"nonce": hung_nonce}))
        .await?;
    anyhow::ensure!(
        rescue.is_success(),
        "advance after stuck_after: {}",
        failures(&rescue)
    );
    // Poll the first transaction instead of waiting on it: a wait that outlasts the RPC's patience is an
    // error, and the yield times out only after about 200 blocks.
    // Each poll of a transaction that is still waiting can block for seconds, so go past the timeout first.
    for _ in 0..5 {
        slow.worker.fast_forward(60).await?;
    }
    let mut original = None;
    for _ in 0..40 {
        if let Ok(std::task::Poll::Ready(result)) = running.status().await {
            original = Some(result);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    let original =
        original.ok_or_else(|| anyhow::anyhow!("the hung execute_decision never finished"))?;
    let executed = event_data(&rescue, "executed");
    let amount_out: u128 = executed
        .as_ref()
        .and_then(|data| data["amount_out"].as_str())
        .ok_or_else(|| anyhow::anyhow!("the rescuing advance should end in `executed`"))?
        .parse()?;
    let (usdc_after, wnear_after) = book(&slow).await?;
    run.step(
        "advance after stuck_after, then the late original answer arrives: the swap executes once",
        event_count(&rescue, "probing") == 1
            && event_count(&rescue, "executed") == 1
            && event_count(&original, "executed") == 0
            && event_count(&original, "swap_reverted") == 0
            && event_count(&original, "stuck") == 0
            && delta(usdc_book, usdc_after) == -1_000_000
            && delta(wnear_book, wnear_after) == amount_out as i128
            && stage(&slow).await? == json!("Idle"),
        None,
        json!({"amount_in": "1000000", "amount_out": amount_out.to_string(), "executed_events": event_count(&rescue, "executed") + event_count(&original, "executed"),
               "probing_events": event_count(&rescue, "probing"), "stage": "Idle"}),
    );
    run.step(
        "Ref holds nothing for the vault, the ledger is empty and the wallets equal the books",
        rhea_holds(&slow).await? == (0, 0)
            && rhea_ledger(&slow).await? == (0, 0)
            && wallet_of(&slow, &slow.usdc, &slow.vault_id).await? == usdc_after
            && wallet_of(&slow, &slow.wnear, &slow.vault_id).await? == wnear_after
            && books(&slow).await? != slow_before,
        None,
        json!({"in_ref": "0", "ledger": "0"}),
    );
    run.note(
        "LEDGER",
        "ledger_after differs from ledger_before: the recovered swap returned the USDC; the donation sits at Ref and in no book",
    );
    run.finish(&env, before, ledger(&env).await?)
}
