//! Attack Lab, first five attacks (SPEC section 5, S3). Each test attacks a sandbox vault, writes
//! `<name>.json` in the proof directory with its verdict and the ledger before and after, and only then
//! asserts, so `tools/attacks/<name>` can tell a breach (exit 1) from a tool error (exit 2).
//! Times in a proof are seconds after the attack's first trade, so a proof is the same on every run.
//!
//! Timing attacks run on the testnet profile of SPEC 3.6 (`epoch_len` 600, `cooldown` 60):
//! `fast_forward` moves about 116 blocks a second and a block is 0.3 s, so one mainnet
//! `epoch_len` of 21,600 s would take ten minutes. The limits under test are the same code.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use foundling_sandbox::{
    event_data, events, failures, Foundling, Setup, CHAIN, COMMITMENT, NEAR_FEED, NEAR_PRICE,
    USDC_FEED, WASM_HASH,
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
/// The chain clock also follows the wall clock, about a second per second, so a long jump
/// overshoots by as long as the jump took to run. On a slow runner a 220 s jump passed its target
/// by ten seconds or more. Short jumps keep the overshoot to a block or two.
const MAX_JUMP_BLOCKS: u64 = 60;

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
    /// Every account that ran a receipt of the `execute_decision` transaction.
    executors: Vec<String>,
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
        executors: Vec::new(),
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
        let mut executors: Vec<String> = executed
            .outcomes()
            .iter()
            .map(|outcome| outcome.executor_id.to_string())
            .collect();
        executors.sort();
        executors.dedup();
        outcome.executors = executors;
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

async fn wallet_of(
    env: &Foundling,
    token: &near_workspaces::Contract,
    account: &near_workspaces::AccountId,
) -> anyhow::Result<String> {
    env.view_contract(token, "ft_balance_of", json!({"account_id": account}))
        .await
}

/// What a trade would move: the books, shares, Ref's ledger and the vault's wallets. The stage
/// is left out because a cycle changes it legitimately.
async fn balances(env: &Foundling) -> anyhow::Result<Value> {
    Ok(json!({
        "book": env.view_vault::<Value>("book", json!({})).await?,
        "total_shares": env.view_vault::<String>("total_shares", json!({})).await?,
        "rhea_book": env.view_vault::<Value>("rhea_book", json!({})).await?,
        "wallet_usdc": wallet_of(env, &env.usdc, &env.vault_id).await?,
        "wallet_wnear": wallet_of(env, &env.wnear, &env.vault_id).await?,
    }))
}

/// `balances` plus the two turnover windows. The windows empty by themselves as the clock moves,
/// so only compare this across a span shorter than `epoch_len`.
async fn ledger(env: &Foundling) -> anyhow::Result<Value> {
    let mut ledger = balances(env).await?;
    for (field, token) in [("window_usdc", "Usdc"), ("window_wnear", "Wnear")] {
        ledger[field] = env
            .view_vault::<Value>("window_used", json!({"token_in": token}))
            .await?;
    }
    Ok(ledger)
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

/// Moves the chain clock to `target` seconds, passing it by no more than a short jump's worth.
async fn wait_until(env: &Foundling, target: u64) -> anyhow::Result<()> {
    loop {
        let now = head_second(env).await?;
        if now >= target {
            return Ok(());
        }
        let blocks = ((target - now) * BLOCKS_PER_SECOND_NUM / BLOCKS_PER_SECOND_DEN)
            .clamp(1, MAX_JUMP_BLOCKS);
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
    notes: Vec<Value>,
}

impl Run {
    fn new(attack: &'static str, expected: &'static [&'static str]) -> Self {
        Self {
            attack,
            expected,
            held: true,
            steps: Vec::new(),
            observed: Vec::new(),
            notes: Vec::new(),
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

    /// Evidence that is not a defence: setup and controls. If one of these is wrong the attack
    /// was never mounted, which is a tool error (no proof), so callers `ensure!` it first.
    fn context(&mut self, label: &str, detail: Value) {
        self.steps
            .push(json!({"step": label, "held": null, "observed": null, "detail": detail}));
    }

    fn note(&mut self, code: &str, why: &str) {
        self.notes.push(json!({"code": code, "note": why}));
    }

    fn finish(self, env: &Foundling, before: Value, after: Value) -> anyhow::Result<()> {
        let wasm = foundling_sandbox::wasm("vault", "foundling_vault");
        // proofs/attack/reproducible holds the proofs committed from a run on the reproducible build;
        // any other run writes to the ignored proofs/attack/local unless FOUNDLING_PROOF_DIR says so.
        let dir: PathBuf = match std::env::var_os("FOUNDLING_PROOF_DIR") {
            Some(dir) => dir.into(),
            None => [
                env!("CARGO_MANIFEST_DIR"),
                "..",
                "proofs",
                "attack",
                "local",
            ]
            .iter()
            .collect(),
        };
        std::fs::create_dir_all(&dir)?;
        // A step can be right about its own condition and still have seen the wrong code, so
        // the codes are held to the registry's list on top of the steps.
        let unexpected: Vec<&String> = self
            .observed
            .iter()
            .filter(|code| !self.expected.contains(&code.as_str()))
            .collect();
        let held = self.held && unexpected.is_empty();
        let proof = json!({
            "attack": self.attack,
            "verdict": if held { "held" } else { "breached" },
            // web/lib/proof/sample.ts reads this: "PASS" shows as Pass, anything else as Fail.
            "result": if held { "PASS" } else { "FAIL" },
            "expected_codes": self.expected,
            "observed_codes": self.observed,
            "unexpected_codes": unexpected,
            "target": "local near-workspaces sandbox: the vault under contracts/vault with the mocks under contracts/mock-*",
            "vault_wasm_sha256": format!("{:x}", Sha256::digest(&wasm)),
            "policy": env.config["policy"],
            "ledger_before": before,
            "ledger_after": after,
            "steps": self.steps,
            "not_exercised": self.notes,
        });
        std::fs::write(
            dir.join(format!("{}.json", self.attack)),
            serde_json::to_string_pretty(&proof)? + "\n",
        )?;
        assert!(
            held,
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
    anyhow::ensure!(
        at_cap.rejected.is_none() && at_cap.started,
        "control failed: exactly the cap should trade: {at_cap:?}"
    );
    run.context(
        "control: exactly the cap is not rejected, so the line is the cap itself",
        json!({"nonce": at_cap.nonce, "amount_in": cap.to_string()}),
    );

    run.finish(&env, before, after_one_over)
}

/// Which of `codes` a refused call names, for a method that refuses by panicking.
fn refusal<'a>(text: Option<&str>, codes: &[&'a str]) -> Option<&'a str> {
    let text = text?;
    codes.iter().copied().find(|code| text.contains(code))
}

fn refused_text(result: &near_workspaces::result::ExecutionFinalResult) -> Option<String> {
    result.is_failure().then(|| failures(result))
}

/// Decision v1 is bound to one vault and one nonce, and every run of the mock OutLayer can be
/// told to answer with another's. None of these may reach the book.
#[tokio::test]
async fn replay() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new(
        "replay",
        &["NONCE_MISMATCH", "EXPIRED", "FROZEN", "CycleFailed"],
    );
    let before = settle_deposit(&env).await?;

    let spent = decide(&env, template("buy_risk", 1_000_000)).await?;
    let after_trade = balances(&env).await?;
    anyhow::ensure!(
        spent.started,
        "setup failed: a real buy should execute: {spent:?}"
    );
    run.context(
        "setup: a real buy executes, which spends its nonce",
        json!({"nonce": spent.nonce}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let mut old = template("buy_risk", 1_000_000);
    old["nonce"] = json!(spent.nonce);
    let replayed = decide(&env, old).await?;
    run.step(
        "the spent decision, replayed with its old nonce",
        replayed.failed.as_deref() == Some("NONCE_MISMATCH")
            && !replayed.started
            && balances(&env).await? == after_trade,
        replayed.failed.as_deref(),
        json!({"replayed_nonce": spent.nonce, "cycle_nonce": replayed.nonce, "stage": stage(&env).await?}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let mut foreign = template("buy_risk", 1_000_000);
    foreign["vault"] = json!("other-vault.test.near");
    let other_vault = decide(&env, foreign).await?;
    run.step(
        "a decision made for another vault",
        other_vault.failed.as_deref() == Some("NONCE_MISMATCH")
            && !other_vault.started
            && balances(&env).await? == after_trade,
        other_vault.failed.as_deref(),
        json!({"cycle_nonce": other_vault.nonce}),
    );

    let stale = refused_text(&execute(&env, spent.nonce).await?);
    run.step(
        "execute_decision on a nonce that already ran",
        refusal(stale.as_deref(), &["NOT_READY"]).is_some() && balances(&env).await? == after_trade,
        None,
        json!({"nonce": spent.nonce, "refused_with": refusal(stale.as_deref(), &["NOT_READY"])}),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let nothing = cycle(&env, json!("Null")).await?;
    run.step(
        "OutLayer answers null",
        nothing.failed.as_deref() == Some("NULL_RESULT")
            && !nothing.started
            && balances(&env).await? == after_trade,
        nothing.failed.as_deref().map(|_| "CycleFailed"),
        json!({"event": "cycle_failed", "code": nothing.failed}),
    );

    // A good decision that waits past `decision_ttl` (600 s) before the keeper acts on it.
    wait_seconds(&env, COOLDOWN + 1).await?;
    env.set_next(json!({"Decision": {"template": template("buy_risk", 1_000_000)}}))
        .await?;
    let late = env.trigger_cycle().await?;
    anyhow::ensure!(late.is_success(), "{}", failures(&late));
    let late_nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    anyhow::ensure!(
        stage(&env).await?.get("DecisionReady").is_some(),
        "setup failed: the late decision should be ready"
    );
    let wrong = refused_text(&execute(&env, late_nonce + 1).await?);
    run.step(
        "execute_decision with the wrong nonce while a decision is ready",
        refusal(wrong.as_deref(), &["NOT_READY"]).is_some()
            && stage(&env).await?.get("DecisionReady").is_some()
            && balances(&env).await? == after_trade,
        None,
        json!({"ready_nonce": late_nonce, "called_with": late_nonce + 1, "refused_with": refusal(wrong.as_deref(), &["NOT_READY"])}),
    );
    wait_seconds(&env, 601).await?;
    let expired = refused_text(&execute(&env, late_nonce).await?);
    let cleared = env
        .call_vault(&env.stranger, "expire_decision", json!({}))
        .await?;
    run.step(
        "execute_decision after the decision expired, then anyone clears it",
        refusal(expired.as_deref(), &["EXPIRED"]).is_some()
            && code_of(event_data(&cleared, "cycle_failed")).as_deref() == Some("EXPIRED")
            && stage(&env).await? == json!("Idle")
            && balances(&env).await? == after_trade,
        refusal(expired.as_deref(), &["EXPIRED"]),
        json!({"nonce": late_nonce}),
    );

    // The guardian freezes between the decision and the keeper's call. A freeze cannot land
    // between `trigger_cycle` and `on_decision` here because the mock answers in one transaction.
    env.set_next(json!({"Decision": {"template": template("buy_risk", 1_000_000)}}))
        .await?;
    let ready = env.trigger_cycle().await?;
    anyhow::ensure!(ready.is_success(), "{}", failures(&ready));
    let frozen_nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    let frozen = env.call_vault(&env.guardian, "freeze", json!({})).await?;
    anyhow::ensure!(frozen.is_success(), "{}", failures(&frozen));
    let blocked = execute(&env, frozen_nonce).await?;
    let blocked_text = refused_text(&blocked);
    let traded = events(&blocked)
        .iter()
        .any(|e| e["event"] == "swap_started");
    run.step(
        "a decision ready when the guardian freezes",
        refusal(blocked_text.as_deref(), &["FROZEN"]).is_some()
            && !traded
            && balances(&env).await? == after_trade,
        refusal(blocked_text.as_deref(), &["FROZEN"]),
        json!({"nonce": frozen_nonce, "seen_as": "panic of execute_decision, not a Rejected event"}),
    );
    run.note(
        "FROZEN",
        "Rejected(FROZEN) from on_price and from on_decision cannot be staged: the mocks answer \
         inside one transaction, so a freeze cannot land between two receipts. Covered by the \
         unit tests in contracts/vault/src/tests/swap.rs and flows.rs",
    );

    run.finish(&env, before, balances(&env).await?)
}

async fn window_usdc(env: &Foundling) -> anyhow::Result<u128> {
    let used: String = env
        .view_vault("window_used", json!({"token_in": "Usdc"}))
        .await?;
    Ok(used.parse()?)
}

/// The head block's second and `window_used` read at that same block. Two separate reads of
/// the head could straddle a new block, and then the pair would not belong together.
async fn window_sample(env: &Foundling) -> anyhow::Result<(u64, u128)> {
    let block = env.worker.view_block().await?;
    let used: String = env
        .worker
        .view(&env.vault_id, "window_used")
        .args_json(json!({"token_in": "Usdc"}))
        .block_hash(*block.hash())
        .await?
        .json()?;
    Ok((block.timestamp() / 1_000_000_000, used.parse()?))
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
    let first_at = first
        .started_at
        .ok_or_else(|| anyhow::anyhow!("setup failed: the first chunk should trade: {first:?}"))?;
    run.context("first chunk is accepted", json!({"nonce": first.nonce}));

    wait_until(&env, first_at + EPOCH_LEN / 2).await?;
    let second = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_second = ledger(&env).await?;
    anyhow::ensure!(
        second.started && window_usdc(&env).await? == 2 * CHUNK,
        "setup failed: the second chunk should trade and fill the window to 3 USDC: {second:?}"
    );
    run.context(
        "second chunk, half an epoch later, is accepted",
        json!({"nonce": second.nonce, "window": 2 * CHUNK}),
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

    // Thirty seconds before the first chunk leaves the window it still counts.
    wait_until(&env, first_at + EPOCH_LEN - 30).await?;
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

    // The window is half open: an entry counts while `at + epoch_len > now`. Let the chain clock
    // run across the edge on its own (it follows the wall clock, a block every ~0.12 s) and read
    // `window_used` pinned to the head block each time, so the pair (second, used) is one block's.
    let leaves_at = first_at + EPOCH_LEN;
    anyhow::ensure!(
        head_second(&env).await? + 3 < leaves_at,
        "setup failed: the chain is already at the edge of the window"
    );
    wait_until(&env, leaves_at - 3).await?;
    let mut samples: Vec<(u64, u128)> = Vec::new();
    loop {
        let (second, used) = window_sample(&env).await?;
        if second > leaves_at + 2 {
            break;
        }
        if samples.last().map(|(s, _)| *s) != Some(second) {
            samples.push((second, used));
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
    let edge_ok = samples.iter().all(|(second, used)| {
        *used
            == if *second < leaves_at {
                2 * CHUNK
            } else {
                CHUNK
            }
    });
    anyhow::ensure!(
        samples.iter().any(|(s, _)| *s == leaves_at - 1)
            && samples.iter().any(|(s, _)| *s == leaves_at),
        "the polling skipped a second at the edge at {leaves_at}: {samples:?}"
    );
    run.step(
        "the first chunk leaves the window at exactly at + epoch_len, not before",
        edge_ok,
        None,
        json!({"leaves_at": EPOCH_LEN, "samples_around_the_edge": samples.iter().filter(|(second, _)| second.abs_diff(leaves_at) <= 2).map(|(second, used)| (second.saturating_sub(first_at), used)).collect::<Vec<_>>()}),
    );

    // Cooldown has passed since `inside`; the first chunk is gone but the second is not.
    wait_until(&env, leaves_at + COOLDOWN).await?;
    let fourth = decide(&env, template("buy_risk", CHUNK)).await?;
    let after_fourth = ledger(&env).await?;
    anyhow::ensure!(
        fourth.started && window_usdc(&env).await? == 2 * CHUNK,
        "after the boundary one chunk should fit again: {fourth:?}"
    );
    run.context(
        "after the boundary one chunk fits again",
        json!({"nonce": fourth.nonce, "window": 2 * CHUNK}),
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

    run.finish(&env, before, after_fifth)
}

/// How old the mock oracle says a feed is. Past `price_max_age` it answers `null`, as the real one does.
async fn set_age(env: &Foundling, feed: &str, price: u128, lag_seconds: u64) -> anyhow::Result<()> {
    let result = env
        .parent
        .call(env.oracle.id(), "set_feed")
        .args_json(json!({
            "price_id": feed,
            "feed": {"price": price.to_string(), "conf": "10000", "expo": -8, "lag_seconds": lag_seconds},
        }))
        .transact()
        .await?;
    anyhow::ensure!(result.is_success(), "set_feed: {}", failures(&result));
    Ok(())
}

async fn requests(env: &Foundling) -> anyhow::Result<u64> {
    env.view_contract(&env.outlayer, "request_count", json!({}))
        .await
}

/// A decision waits in `DecisionReady` while the price is missing, and nothing trades on a
/// price the oracle will not vouch for. `price_max_age` is 120 s, so a feed 121 s old is `null`.
/// The mock cannot show `PRICE_STALE`: it dates a feed `now - lag` and withholds it when the lag
/// passes the age, so no feed it returns is older than the vault allows.
#[tokio::test]
async fn stale_price() -> anyhow::Result<()> {
    const STALE: u64 = 121;
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("stale-price", &["PRICE_UNAVAILABLE", "PRICE_STALE"]);
    let before = settle_deposit(&env).await?;

    set_age(&env, NEAR_FEED, NEAR_PRICE, STALE).await?;
    env.set_next(json!({"Decision": {"template": template("buy_risk", 1_000_000)}}))
        .await?;
    let triggered = env.trigger_cycle().await?;
    anyhow::ensure!(triggered.is_success(), "{}", failures(&triggered));
    let nonce: u64 = env.view_vault("last_nonce", json!({})).await?;
    let ready = stage(&env).await?;
    let runs_before = requests(&env).await?;

    let stale_near = execute(&env, nonce).await?;
    let code = code_of(event_data(&stale_near, "rejected"));
    run.step(
        "NEAR/USD feed 121 s old",
        code.as_deref() == Some("PRICE_UNAVAILABLE")
            && !events(&stale_near)
                .iter()
                .any(|e| e["event"] == "swap_started")
            && stage(&env).await? == ready
            && ledger(&env).await? == before,
        code.as_deref(),
        json!({"nonce": nonce, "stage_after": "DecisionReady, same nonce and expires_at"}),
    );

    let again = execute(&env, nonce).await?;
    let code = code_of(event_data(&again, "rejected"));
    run.step(
        "the keeper retries and the feed is still stale",
        code.as_deref() == Some("PRICE_UNAVAILABLE")
            && stage(&env).await? == ready
            && requests(&env).await? == runs_before,
        code.as_deref(),
        json!({"nonce": nonce, "new_runs_paid": requests(&env).await? - runs_before}),
    );

    set_age(&env, NEAR_FEED, NEAR_PRICE, 0).await?;
    set_age(&env, USDC_FEED, 100_000_000, STALE).await?;
    let stale_usdc = execute(&env, nonce).await?;
    let code = code_of(event_data(&stale_usdc, "rejected"));
    run.step(
        "USDC/USD feed 121 s old with NEAR/USD fresh",
        code.as_deref() == Some("PRICE_UNAVAILABLE")
            && stage(&env).await? == ready
            && ledger(&env).await? == before,
        code.as_deref(),
        json!({"nonce": nonce}),
    );

    set_age(&env, USDC_FEED, 100_000_000, 0).await?;
    let recovered = execute(&env, nonce).await?;
    anyhow::ensure!(
        events(&recovered)
            .iter()
            .any(|e| e["event"] == "swap_started")
            && requests(&env).await? == runs_before,
        "control failed: with fresh feeds the same decision should trade without a new run"
    );
    run.context(
        "control: with both feeds fresh the same decision trades, without a new run",
        json!({"nonce": nonce, "new_runs_paid": requests(&env).await? - runs_before}),
    );

    run.note(
        "PRICE_STALE",
        "not reachable with the mock oracle; see the test doc",
    );
    run.finish(&env, before, ledger(&env).await?)
}

/// Decision v1 has no field for a route, a pool, an asset or a receiver, so an agent has no way
/// to name a way out. The vault ignores such fields and trades only through the registered
/// pool, which is I9: no receipt of the trade runs anywhere but the registered accounts. An
/// action the vault does not know is `CycleFailed(MALFORMED)`. SPEC 5 lists no `Rejected` code
/// for a route, because there is none to emit.
#[tokio::test]
async fn bad_route() -> anyhow::Result<()> {
    let env = attack_env(testnet_timing()).await?;
    let mut run = Run::new("bad-route", &["MALFORMED"]);
    let before = settle_deposit(&env).await?;
    // The keeper signs the call, so its own account runs the receipt that converts the transaction.
    let registered: Vec<String> = [
        env.keeper.id().as_str(),
        env.vault_id.as_str(),
        env.usdc.id().as_str(),
        env.wnear.id().as_str(),
        env.rhea.id().as_str(),
        env.oracle.id().as_str(),
    ]
    .iter()
    .map(|account| account.to_string())
    .collect();
    let attacker = env.stranger.id().to_string();

    let nonce: u64 = env.view_vault::<u64>("last_nonce", json!({})).await? + 1;
    let poisoned = json!({
        "v": 1, "vault": env.vault_id, "chain": CHAIN, "nonce": nonce,
        "action": "buy_risk", "amount_in": "1000000", "ref_price": NEAR_PRICE.to_string(),
        "commitment": COMMITMENT, "wasm_hash": WASM_HASH,
        "receiver_id": attacker, "token_out": attacker, "pool_id": 1,
        "route": [{"pool_id": 1, "token_in": env.usdc.id(), "token_out": attacker}],
    })
    .to_string();
    let smuggled = cycle(&env, json!({"Raw": {"payload": poisoned}})).await?;
    let leaked: Vec<&String> = smuggled
        .executors
        .iter()
        .filter(|account| !registered.contains(account))
        .collect();
    let attacker_holds = [
        wallet_of(&env, &env.usdc, env.stranger.id()).await?,
        wallet_of(&env, &env.wnear, env.stranger.id()).await?,
    ];
    let code = smuggled.rejected.clone().or(smuggled.failed.clone());
    run.step(
        "a decision that names a receiver, a pool and a route of the attacker's choosing",
        smuggled.started && code.is_none() && leaked.is_empty() && attacker_holds == ["0", "0"],
        code.as_deref(),
        json!({
            "nonce": nonce,
            "traded_over_the_registered_route": smuggled.started,
            "accounts_that_ran_a_receipt": smuggled.executors,
            "outside_the_registered_set": leaked,
            "attacker_balances": attacker_holds,
        }),
    );

    wait_seconds(&env, COOLDOWN + 1).await?;
    let after_trade = balances(&env).await?;
    let nonce = nonce + 1;
    let transfer = json!({
        "v": 1, "vault": env.vault_id, "chain": CHAIN, "nonce": nonce,
        "action": "transfer_out", "amount_in": "1000000", "ref_price": NEAR_PRICE.to_string(),
        "commitment": COMMITMENT, "wasm_hash": WASM_HASH, "receiver_id": attacker,
    })
    .to_string();
    let unknown = cycle(&env, json!({"Raw": {"payload": transfer}})).await?;
    let code_unknown = unknown.rejected.clone().or(unknown.failed.clone());
    // The envelope (vault, chain, nonce, commitment, hash) is the one the step above traded
    // with, so the action is the only thing that can have made this payload malformed.
    run.step(
        "an action that is not buy or sell",
        code_unknown.as_deref() == Some("MALFORMED")
            && !unknown.started
            && unknown.executors.is_empty()
            && balances(&env).await? == after_trade,
        code_unknown.as_deref(),
        json!({"nonce": nonce, "envelope_control": "same envelope as the trading step above"}),
    );

    run.finish(&env, before, ledger(&env).await?)
}
