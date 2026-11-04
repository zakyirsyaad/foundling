//! Attack Lab, first five attacks (SPEC section 5, S3). Each test attacks a sandbox vault, writes
//! `proofs/attack/<name>.json` with its verdict and the ledger before and after, and only then
//! asserts, so `tools/attacks/<name>` can tell a breach (exit 1) from a tool error (exit 2).
//! Times in a proof are seconds after the attack's first trade, so a proof is the same on every run.
//!
//! Timing attacks run on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60):
//! `fast_forward` moves about 116 blocks a second and a block is 0.3 s, so one mainnet
//! `epoch_len` of 21,600 s would take ten minutes. The limits under test are the same code.

use std::path::PathBuf;

use foundling_sandbox::{
    event_data, events, failures, Foundling, Setup, CHAIN, COMMITMENT, NEAR_PRICE, WASM_HASH,
};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const DEPOSIT: u128 = 20_000_000;
/// Ref's wallet needs tokens to pay a withdraw, and the mock has no other way to get them.
const REF_LIQUIDITY_USDC: u128 = 1_000_000_000;
const REF_LIQUIDITY_WNEAR: u128 = 1_000_000_000_000_000_000_000_000_000;
const COOLDOWN: u64 = 60;
const EPOCH_LEN: u64 = 600;
/// A block is 0.3 s of chain time, so this many blocks cover a second without passing it.
const BLOCKS_PER_SECOND_NUM: u64 = 10;
const BLOCKS_PER_SECOND_DEN: u64 = 3;

fn testnet_timing() -> Value {
    json!({"epoch_len": EPOCH_LEN, "cooldown": COOLDOWN})
}

/// A sandbox vault holding `DEPOSIT` queued by alice, with Ref able to pay out.
async fn attack_env(policy: Value) -> anyhow::Result<Foundling> {
    let env = Foundling::start_with(Setup {
        policy,
        ..Default::default()
    })
    .await?;
    env.ready().await?;
    env.mint(&env.usdc, env.rhea.id(), REF_LIQUIDITY_USDC)
        .await?;
    env.mint(&env.wnear, env.rhea.id(), REF_LIQUIDITY_WNEAR)
        .await?;
    env.mint(&env.usdc, env.alice.id(), DEPOSIT).await?;
    let deposited = env
        .alice
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.vault_id,
            "amount": DEPOSIT.to_string(),
            "msg": "deposit",
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    anyhow::ensure!(deposited.is_success(), "deposit: {}", failures(&deposited));
    Ok(env)
}

fn template(action: &str, amount_in: u128) -> Value {
    json!({
        "chain": CHAIN,
        "commitment": COMMITMENT,
        "wasm_hash": WASM_HASH,
        "action": action,
        "amount_in": amount_in.to_string(),
        "ref_price": NEAR_PRICE.to_string(),
        "nonce": null,
        "vault": null,
    })
}

fn code_of(event: Option<Value>) -> Option<String> {
    event.and_then(|data| data["code"].as_str().map(str::to_string))
}

/// What one cycle did, read from the events of its transactions.
#[derive(Debug)]
struct Outcome {
    nonce: u64,
    /// `Rejected(code)` from `on_price`, or from `on_decision` while frozen.
    rejected: Option<String>,
    /// `CycleFailed(code)` from `on_decision`.
    failed: Option<String>,
    /// A swap went out.
    started: bool,
    /// The chain second the swap was debited from the book, which is when the window stamps it.
    started_at: Option<u64>,
    /// A method refused the call outright, with this text in the failure.
    refused: Option<String>,
}

/// One keeper cycle: ask OutLayer for `answer`, then execute what the vault accepted.
async fn cycle(env: &Foundling, answer: Value) -> anyhow::Result<Outcome> {
    env.set_next(answer).await?;
    let triggered = env.trigger_cycle().await?;
    anyhow::ensure!(
        triggered.is_success(),
        "trigger_cycle: {}",
        failures(&triggered)
    );
    let nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    let mut outcome = Outcome {
        nonce,
        rejected: code_of(event_data(&triggered, "rejected")),
        failed: code_of(event_data(&triggered, "cycle_failed")),
        started: false,
        started_at: None,
        refused: None,
    };
    let stage: Value = env.view_vault("stage", json!({})).await?;
    if stage.get("DecisionReady").is_some() {
        let executed = execute(env, nonce).await?;
        outcome.started = events(&executed)
            .iter()
            .any(|e| e["event"] == "swap_started");
        outcome.rejected = code_of(event_data(&executed, "rejected"));
        if outcome.started {
            outcome.started_at = Some(second_of(env, &executed, "swap_started").await?);
        }
        if executed.is_failure() {
            outcome.refused = Some(failures(&executed));
        }
    }
    Ok(outcome)
}

async fn decide(env: &Foundling, template: Value) -> anyhow::Result<Outcome> {
    cycle(env, json!({"Decision": {"template": template}})).await
}

async fn execute(
    env: &Foundling,
    nonce: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    env.call_vault(&env.keeper, "execute_decision", json!({ "nonce": nonce }))
        .await
}

async fn wallet_of_vault(
    env: &Foundling,
    token: &near_workspaces::Contract,
) -> anyhow::Result<String> {
    env.view_contract(token, "ft_balance_of", json!({"account_id": env.vault_id}))
        .await
}

/// Everything a trade would move: the books, shares, Ref's ledger, the vault's wallets and the
/// two turnover windows. The stage is left out because a cycle changes it legitimately.
async fn ledger(env: &Foundling) -> anyhow::Result<Value> {
    Ok(json!({
        "book": env.view_vault::<Value>("book", json!({})).await?,
        "total_shares": env.view_vault::<String>("total_shares", json!({})).await?,
        "rhea_book": env.view_vault::<Value>("rhea_book", json!({})).await?,
        "wallet_usdc": wallet_of_vault(env, &env.usdc).await?,
        "wallet_wnear": wallet_of_vault(env, &env.wnear).await?,
        "window_usdc": env.view_vault::<String>("window_used", json!({"token_in": "Usdc"})).await?,
        "window_wnear": env.view_vault::<String>("window_used", json!({"token_in": "Wnear"})).await?,
    }))
}

/// A hold cycle: it mints the queued deposit and trades nothing, so the next ledger is the
/// state an attack starts from. Returns it after the cooldown has passed.
async fn settle_deposit(env: &Foundling) -> anyhow::Result<Value> {
    let held = decide(env, template("none", 0)).await?;
    anyhow::ensure!(
        held.rejected.is_none() && held.failed.is_none() && !held.started,
        "{held:?}"
    );
    wait_seconds(env, COOLDOWN + 1).await?;
    ledger(env).await
}

async fn stage(env: &Foundling) -> anyhow::Result<Value> {
    env.view_vault("stage", json!({})).await
}

async fn head_second(env: &Foundling) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000_000)
}

/// Moves the chain clock to `target` seconds without passing it by more than a block.
async fn wait_until(env: &Foundling, target: u64) -> anyhow::Result<()> {
    loop {
        let now = head_second(env).await?;
        if now >= target {
            return Ok(());
        }
        let blocks = ((target - now) * BLOCKS_PER_SECOND_NUM / BLOCKS_PER_SECOND_DEN).max(1);
        env.worker.fast_forward(blocks).await?;
    }
}

/// The second of the block whose receipt logged `needle`.
async fn second_of(
    env: &Foundling,
    result: &near_workspaces::result::ExecutionFinalResult,
    needle: &str,
) -> anyhow::Result<u64> {
    let outcome = result
        .outcomes()
        .into_iter()
        .find(|outcome| outcome.logs.iter().any(|log| log.contains(needle)))
        .ok_or_else(|| anyhow::anyhow!("no receipt logged {needle}"))?;
    let block = env
        .worker
        .view_block()
        .block_hash(outcome.block_hash)
        .await?;
    Ok(block.timestamp() / 1_000_000_000)
}

async fn wait_seconds(env: &Foundling, seconds: u64) -> anyhow::Result<()> {
    let target = head_second(env).await? + seconds;
    wait_until(env, target).await
}

/// Collects the steps of one attack and writes the proof before anything asserts.
struct Run {
    attack: &'static str,
    expected: &'static [&'static str],
    held: bool,
    steps: Vec<Value>,
    observed: Vec<String>,
}

impl Run {
    fn new(attack: &'static str, expected: &'static [&'static str]) -> Self {
        Self {
            attack,
            expected,
            held: true,
            steps: Vec::new(),
            observed: Vec::new(),
        }
    }

    fn step(&mut self, label: &str, held: bool, observed: Option<&str>, detail: Value) {
        self.held &= held;
        if let Some(code) = observed {
            if !self.observed.iter().any(|seen| seen == code) {
                self.observed.push(code.to_string());
            }
        }
        self.steps
            .push(json!({"step": label, "held": held, "observed": observed, "detail": detail}));
    }

    fn finish(self, before: Value, after: Value) -> anyhow::Result<()> {
        let dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "proofs", "attack"]
            .iter()
            .collect();
        std::fs::create_dir_all(&dir)?;
        let proof = json!({
            "attack": self.attack,
            "verdict": if self.held { "held" } else { "breached" },
            "expected_codes": self.expected,
            "observed_codes": self.observed,
            "target": "local near-workspaces sandbox: the vault under contracts/vault with the mocks under contracts/mock-*",
            "ledger_before": before,
            "ledger_after": after,
            "steps": self.steps,
        });
        std::fs::write(
            dir.join(format!("{}.json", self.attack)),
            serde_json::to_string_pretty(&proof)? + "\n",
        )?;
        assert!(
            self.held,
            "{} was not held: {}",
            self.attack,
            serde_json::to_string_pretty(&proof["steps"])?
        );
        Ok(())
    }
}

#[tokio::test]
async fn over_cap() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("over-cap", &["OVER_CAP"]);

    // Minting alice's deposit makes NAV 20 USDC, so `cap_bps` of 10% gives a cap of 2 USDC.
    let cap = DEPOSIT / 10;
    let before = settle_deposit(&env).await?;
    anyhow::ensure!(before["book"]["usdc"] == DEPOSIT.to_string(), "{before}");

    let big = decide(&env, template("buy_risk", 7_000_000)).await?;
    let after_big = ledger(&env).await?;
    run.step(
        "7 USDC against a cap of 2 USDC",
        big.rejected.as_deref() == Some("OVER_CAP") && !big.started && after_big == before,
        big.rejected.as_deref(),
        json!({"nonce": big.nonce, "amount_in": "7000000", "cap": cap.to_string(), "ledger_unchanged": after_big == before}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let one_over = decide(&env, template("buy_risk", cap + 1)).await?;
    let after_one_over = ledger(&env).await?;
    run.step(
        "one unit over the cap",
        one_over.rejected.as_deref() == Some("OVER_CAP")
            && !one_over.started
            && after_one_over == before,
        one_over.rejected.as_deref(),
        json!({"nonce": one_over.nonce, "amount_in": (cap + 1).to_string(), "ledger_unchanged": after_one_over == before}),
    );
    run.step(
        "stage back to Idle after both rejections",
        stage(&env).await? == json!("Idle"),
        None,
        json!({}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let at_cap = decide(&env, template("buy_risk", cap)).await?;
    run.step(
        "control: exactly the cap is not rejected, so the line is the cap itself",
        at_cap.rejected.is_none() && at_cap.started,
        None,
        json!({"nonce": at_cap.nonce, "amount_in": cap.to_string()}),
    );

    run.finish(before, after_one_over)
}

async fn window_usdc(env: &Foundling) -> anyhow::Result<u128> {
    let used: String = env
        .view_vault("window_used", json!({"token_in": "Usdc"}))
        .await?;
    Ok(used.parse()?)
}

/// Buys of 1.5 USDC at NAV 20: each is under the 2 USDC cap, and the window holds two of them
/// (3.0 of about 4.0), so the third inside one `epoch_len` is the one that must be refused.
#[tokio::test]
async fn drip() -> anyhow::Result<()> {
    const CHUNK: u128 = 1_500_000;
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("drip", &["OVER_EPOCH_CAP"]);
    let before = settle_deposit(&env).await?;

    let first = decide(&env, template("buy_risk", CHUNK)).await?;
    let first_at = first.started_at.unwrap_or_default();
    run.step(
        "first chunk is accepted",
        first.started && first_at > 0,
        None,
        json!({"nonce": first.nonce, "second": 0}),
    );

    wait_until(&env, first_at + EPOCH_LEN / 2).await?;
    let second = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_second = ledger(&env).await?;
    run.step(
        "second chunk, half an epoch later, is accepted",
        second.started && window_usdc(&env).await? == 2 * CHUNK,
        None,
        json!({"nonce": second.nonce, "half_an_epoch_in": second.started_at.is_some_and(|at| at - first_at >= EPOCH_LEN / 2), "window": 2 * CHUNK}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let third = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_third = ledger(&env).await?;
    run.step(
        "third chunk crosses the epoch cap",
        third.rejected.as_deref() == Some("OVER_EPOCH_CAP")
            && !third.started
            && after_third == after_second,
        third.rejected.as_deref(),
        json!({"nonce": third.nonce, "ledger_unchanged": after_third == after_second}),
    );

    // Twenty seconds before the first chunk leaves the window it still counts.
    wait_until(&env, first_at + EPOCH_LEN - 20).await?;
    let inside = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_inside = ledger(&env).await?;
    run.step(
        "just inside the boundary the first chunk still counts",
        inside.rejected.as_deref() == Some("OVER_EPOCH_CAP")
            && !inside.started
            && after_inside == after_second,
        inside.rejected.as_deref(),
        json!({"nonce": inside.nonce, "before_boundary": head_second(&env).await? < first_at + EPOCH_LEN}),
    );

    // The window is half open: an entry counts while `at + epoch_len > now`. Reading the view
    // block by block shows the exact second the first chunk drops out, and that it does.
    let leaves_at = first_at + EPOCH_LEN;
    let mut samples = Vec::new();
    while head_second(&env).await? <= leaves_at + 1 {
        let second = head_second(&env).await?;
        let used = window_usdc(&env).await?;
        if samples.last().map(|(s, _)| *s) != Some(second) {
            samples.push((second, used));
        }
        env.worker.fast_forward(1).await?;
    }
    let edge_ok = samples.iter().all(|(second, used)| {
        *used
            == if *second < leaves_at {
                2 * CHUNK
            } else {
                CHUNK
            }
    });
    let saw_both_sides = samples.iter().any(|(s, _)| *s == leaves_at - 1)
        && samples.iter().any(|(s, _)| *s == leaves_at);
    run.step(
        "the first chunk leaves the window at exactly at + epoch_len, not before",
        edge_ok && saw_both_sides,
        None,
        json!({"leaves_at": EPOCH_LEN, "samples_around_the_edge": samples.iter().filter(|(second, _)| second.abs_diff(leaves_at) <= 3).map(|(second, used)| (second - first_at, used)).collect::<Vec<_>>()}),
    );

    // Cooldown has passed since `inside`; the first chunk is gone but the second is not.
    wait_until(&env, leaves_at + COOLDOWN).await?;
    let fourth = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_fourth = ledger(&env).await?;
    run.step(
        "after the boundary one chunk fits again",
        fourth.started && window_usdc(&env).await? == 2 * CHUNK,
        None,
        json!({"nonce": fourth.nonce, "window": window_usdc(&env).await?.to_string()}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let fifth = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_fifth = ledger(&env).await?;
    run.step(
        "a full epoch after the first chunk the cap still holds: no fixed boundary resets it",
        fifth.rejected.as_deref() == Some("OVER_EPOCH_CAP")
            && !fifth.started
            && after_fifth == after_fourth,
        fifth.rejected.as_deref(),
        json!({"nonce": fifth.nonce, "after_boundary": head_second(&env).await? > first_at + EPOCH_LEN}),
    );

    run.finish(before, after_fifth)
}
