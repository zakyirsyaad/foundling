//! Attack Lab, last five attacks (SPEC section 5): inflated-nav, deflated-sell, never-flat, setup-spam,
//! advance-race. Same contract as batch 1 and 2: each test attacks a sandbox vault, writes
//! `<name>.json` in the proof directory with its verdict and the ledger before and after, and only
//! then asserts, so `tools/attacks/<name>` can tell a breach (exit 1) from a tool error (exit 2).
//! The shared harness is in `common`.
//!
//! Timing runs on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60), as before.

mod common;

use common::*;
use foundling_sandbox::{event_data, failures, Foundling, Setup, NEAR_FEED, NEAR_PRICE};
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
