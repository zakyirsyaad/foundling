//! Shared by the Attack Lab test binaries after batch 1. It follows attacks_batch1.rs on purpose
//! (same proof format, same timing profile) and leaves that file untouched. Each binary uses only
//! part of it, hence the allow.
#![allow(dead_code)]

use std::cell::RefCell;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use foundling_sandbox::{
    event_data, events, failures, Foundling, Setup, CHAIN, COMMITMENT, NEAR_PRICE, WASM_HASH,
};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};

pub const DEPOSIT: u128 = 20_000_000;
/// Ref's wallet needs tokens to pay a withdraw, and the mock has no other way to get them.
pub const REF_LIQUIDITY_USDC: u128 = 1_000_000_000;
pub const REF_LIQUIDITY_WNEAR: u128 = 1_000_000_000_000_000_000_000_000_000;
pub const COOLDOWN: u64 = 60;
pub const EPOCH_LEN: u64 = 600;
/// A block is 0.3 s of chain time, so this many blocks cover a second without passing it.
const BLOCKS_PER_SECOND_NUM: u64 = 10;
const BLOCKS_PER_SECOND_DEN: u64 = 3;
/// The chain clock also follows the wall clock, so a long jump overshoots by as long as the jump
/// took to run. Short jumps keep the overshoot to a block or two.
const MAX_JUMP_BLOCKS: u64 = 60;

pub fn testnet_timing() -> Value {
    json!({"epoch_len": EPOCH_LEN, "cooldown": COOLDOWN})
}

/// A sandbox vault holding `DEPOSIT` queued by alice, with Ref able to pay out.
pub async fn attack_env(policy: Value) -> anyhow::Result<Foundling> {
    attack_env_with(Setup {
        policy,
        ..Default::default()
    })
    .await
}

pub async fn attack_env_with(setup: Setup) -> anyhow::Result<Foundling> {
    let env = Foundling::start_with(setup).await?;
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

pub fn template(action: &str, amount_in: u128) -> Value {
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

pub fn code_of(event: Option<Value>) -> Option<String> {
    event.and_then(|data| data["code"].as_str().map(str::to_string))
}

/// What one cycle did, read from the events of its transactions.
#[derive(Debug)]
pub struct Outcome {
    pub nonce: u64,
    /// `Rejected(code)` from `on_price`, or from `on_decision` while frozen.
    pub rejected: Option<String>,
    /// `CycleFailed(code)` from `on_decision`.
    pub failed: Option<String>,
    /// A swap went out.
    pub started: bool,
}

/// One keeper cycle: ask OutLayer for `answer`, then execute what the vault accepted.
pub async fn cycle(env: &Foundling, answer: Value) -> anyhow::Result<Outcome> {
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
    };
    if stage(env).await?.get("DecisionReady").is_some() {
        let executed = execute(env, nonce).await?;
        outcome.started = swapped(&executed);
        outcome.rejected = code_of(event_data(&executed, "rejected"));
    }
    Ok(outcome)
}

pub async fn decide(env: &Foundling, template: Value) -> anyhow::Result<Outcome> {
    cycle(env, json!({"Decision": {"template": template}})).await
}

/// The keeper's `trigger_cycle` with a decision queued, stopping at `DecisionReady`.
pub async fn decision_ready(env: &Foundling, template: Value) -> anyhow::Result<u64> {
    env.set_next(json!({"Decision": {"template": template}}))
        .await?;
    let triggered = env.trigger_cycle().await?;
    anyhow::ensure!(
        triggered.is_success(),
        "trigger_cycle: {}",
        failures(&triggered)
    );
    anyhow::ensure!(
        stage(env).await?.get("DecisionReady").is_some(),
        "setup failed: no decision is ready: {}",
        stage(env).await?
    );
    env.view_vault("last_nonce", json!({})).await
}

pub async fn execute(env: &Foundling, nonce: u64) -> anyhow::Result<ExecutionFinalResult> {
    env.call_vault(&env.keeper, "execute_decision", json!({ "nonce": nonce }))
        .await
}

pub async fn wallet_of(
    env: &Foundling,
    token: &Contract,
    account: &AccountId,
) -> anyhow::Result<u128> {
    let balance: String = env
        .view_contract(token, "ft_balance_of", json!({"account_id": account}))
        .await?;
    Ok(balance.parse()?)
}

/// What a trade would move: the books, shares, Ref's ledger and the vault's wallets. The stage
/// is left out because a cycle changes it legitimately.
pub async fn balances(env: &Foundling) -> anyhow::Result<Value> {
    Ok(json!({
        "book": env.view_vault::<Value>("book", json!({})).await?,
        "total_shares": env.view_vault::<String>("total_shares", json!({})).await?,
        "rhea_book": env.view_vault::<Value>("rhea_book", json!({})).await?,
        "wallet_usdc": wallet_of(env, &env.usdc, &env.vault_id).await?.to_string(),
        "wallet_wnear": wallet_of(env, &env.wnear, &env.vault_id).await?.to_string(),
    }))
}

/// `balances` plus the two turnover windows. The windows empty by themselves as the clock moves,
/// so only compare this across a span shorter than `epoch_len`.
pub async fn ledger(env: &Foundling) -> anyhow::Result<Value> {
    let mut ledger = balances(env).await?;
    for (field, token) in [("window_usdc", "Usdc"), ("window_wnear", "Wnear")] {
        ledger[field] = env
            .view_vault::<Value>("window_used", json!({"token_in": token}))
            .await?;
    }
    Ok(ledger)
}

/// Everything a refused call must leave alone, including what a role or a policy could change.
pub async fn state(env: &Foundling) -> anyhow::Result<Value> {
    let mut state = balances(env).await?;
    state["stage"] = stage(env).await?;
    for view in [
        "last_nonce",
        "roles",
        "policy",
        "assets",
        "agent",
        "oracle",
        "is_frozen",
        "is_halted",
        "keeper_change",
        "guardian_change",
        "inflight",
        "ops_spent",
        "revealed",
    ] {
        state[view] = env.view_vault::<Value>(view, json!({})).await?;
    }
    for (name, account) in [
        ("alice", env.alice.id()),
        ("stranger", env.stranger.id()),
        ("keeper", env.keeper.id()),
    ] {
        state[format!("{name}_shares")] = env
            .view_vault::<Value>("shares_of", json!({"account": account}))
            .await?;
        state[format!("{name}_pending")] = env
            .view_vault::<Value>("pending_of", json!({"account": account}))
            .await?;
        for token in ["Usdc", "Wnear"] {
            state[format!("{name}_claimable_{token}")] = env
                .view_vault::<Value>("claimable_of", json!({"account": account, "token": token}))
                .await?;
        }
    }
    Ok(state)
}

/// A hold cycle: it mints the queued deposit and trades nothing, so the next ledger is the
/// state an attack starts from. Returns it after the cooldown has passed.
pub async fn settle_deposit(env: &Foundling) -> anyhow::Result<Value> {
    let held = decide(env, template("none", 0)).await?;
    anyhow::ensure!(
        held.rejected.is_none() && held.failed.is_none() && !held.started,
        "{held:?}"
    );
    wait_seconds(env, COOLDOWN + 1).await?;
    ledger(env).await
}

pub async fn stage(env: &Foundling) -> anyhow::Result<Value> {
    env.view_vault("stage", json!({})).await
}

/// The stage's name without its fields, which carry absolute chain times a proof must not hold.
pub async fn stage_name(env: &Foundling) -> anyhow::Result<String> {
    Ok(match stage(env).await? {
        Value::String(name) => name,
        Value::Object(fields) => fields.keys().next().cloned().unwrap_or_default(),
        other => other.to_string(),
    })
}

pub async fn head_second(env: &Foundling) -> anyhow::Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000_000)
}

/// Moves the chain clock to `target` seconds, passing it by no more than a short jump's worth.
pub async fn wait_until(env: &Foundling, target: u64) -> anyhow::Result<()> {
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

pub async fn wait_seconds(env: &Foundling, seconds: u64) -> anyhow::Result<()> {
    let target = head_second(env).await? + seconds;
    wait_until(env, target).await
}

/// Which of `codes` a refused call names, for a method that refuses by panicking.
pub fn refusal<'a>(text: Option<&str>, codes: &[&'a str]) -> Option<&'a str> {
    let text = text?;
    codes.iter().copied().find(|code| {
        // A reason code is matched whole, so EXPIRED does not accept NOT_EXPIRED; a lower-case
        // message ("not enough shares") is matched as text.
        if code.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
            text.split(|c: char| !(c.is_ascii_uppercase() || c == '_'))
                .any(|token| token == *code)
        } else {
            text.contains(code)
        }
    })
}

pub fn refused_text(result: &ExecutionFinalResult) -> Option<String> {
    result.is_failure().then(|| failures(result))
}

pub fn swapped(result: &ExecutionFinalResult) -> bool {
    events(result).iter().any(|e| e["event"] == "swap_started")
}

pub async fn freeze(env: &Foundling) -> anyhow::Result<()> {
    let frozen = env.call_vault(&env.guardian, "freeze", json!({})).await?;
    anyhow::ensure!(frozen.is_success(), "freeze: {}", failures(&frozen));
    Ok(())
}

/// What one `redeem` did, against what the book said it should pay. Every delta is signed: a
/// bug that grows the book, mints shares or shrinks a claim must show up as a wrong number in a
/// step, which the proof records as a breach, and not as an underflow panic, which reads as a
/// tool error.
#[derive(Debug)]
pub struct Redeemed {
    pub shares: u128,
    pub expected_usdc: u128,
    pub expected_wnear: u128,
    /// The wallet delta plus the `claimable` delta, per token: where the payout went.
    pub paid_usdc: i128,
    pub paid_wnear: i128,
    pub in_wallet_usdc: i128,
    pub in_wallet_wnear: i128,
    pub book_usdc_drop: i128,
    pub book_wnear_drop: i128,
    pub shares_drop: i128,
    pub failure: Option<String>,
}

impl Redeemed {
    /// The payout was the pro-rata of the book, paid once, and the shares were burned once.
    pub fn exact(&self) -> bool {
        self.failure.is_none()
            && self.paid_usdc == self.expected_usdc as i128
            && self.paid_wnear == self.expected_wnear as i128
            && self.book_usdc_drop == self.expected_usdc as i128
            && self.book_wnear_drop == self.expected_wnear as i128
            && self.shares_drop == self.shares as i128
            && (self.expected_usdc > 0 || self.expected_wnear > 0)
    }

    pub fn detail(&self) -> Value {
        json!({
            "shares": self.shares.to_string(),
            "expected": {"usdc": self.expected_usdc.to_string(), "wnear": self.expected_wnear.to_string()},
            "paid": {"usdc": self.paid_usdc.to_string(), "wnear": self.paid_wnear.to_string()},
            "of_which_in_wallet": {"usdc": self.in_wallet_usdc.to_string(), "wnear": self.in_wallet_wnear.to_string()},
            "book_drop": {"usdc": self.book_usdc_drop.to_string(), "wnear": self.book_wnear_drop.to_string()},
            "shares_burned": self.shares_drop.to_string(),
            "failure": self.failure,
        })
    }
}

/// `after - before`, signed: a number a step can judge, not an underflow panic.
pub fn delta(before: u128, after: u128) -> i128 {
    after as i128 - before as i128
}

pub async fn claimable(env: &Foundling, who: &Account, token: &str) -> anyhow::Result<u128> {
    let amount: String = env
        .view_vault("claimable_of", json!({"account": who.id(), "token": token}))
        .await?;
    Ok(amount.parse()?)
}

pub async fn book(env: &Foundling) -> anyhow::Result<(u128, u128)> {
    let book: Value = env.view_vault("book", json!({})).await?;
    let amount = |token: &str| -> anyhow::Result<u128> {
        Ok(book[token]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("book has no {token}: {book}"))?
            .parse()?)
    };
    Ok((amount("usdc")?, amount("wnear")?))
}

pub async fn total_shares(env: &Foundling) -> anyhow::Result<u128> {
    let total: String = env.view_vault("total_shares", json!({})).await?;
    Ok(total.parse()?)
}

pub async fn shares_of(env: &Foundling, who: &Account) -> anyhow::Result<u128> {
    let shares: String = env
        .view_vault("shares_of", json!({"account": who.id()}))
        .await?;
    Ok(shares.parse()?)
}

/// `who` redeems `shares`. The pro-rata is computed from the book and total shares read first, so
/// the check does not use the vault's own arithmetic to judge the vault. A failed read ends the run
/// with no proof, which is a tool error; it is never turned into a number.
pub async fn redeem(env: &Foundling, who: &Account, shares: u128) -> anyhow::Result<Redeemed> {
    let (usdc_before, wnear_before) = book(env).await?;
    let total_before = total_shares(env).await?;
    let pro_rata = |amount: u128| {
        amount
            .checked_mul(shares)
            .expect("book times shares fits u128")
            / total_before
    };
    let wallet_usdc = wallet_of(env, &env.usdc, who.id()).await?;
    let wallet_wnear = wallet_of(env, &env.wnear, who.id()).await?;
    let claim_usdc = claimable(env, who, "Usdc").await?;
    let claim_wnear = claimable(env, who, "Wnear").await?;

    let result = who
        .call(&env.vault_id, "redeem")
        .args_json(json!({ "shares": shares.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    let (usdc_after, wnear_after) = book(env).await?;
    let in_wallet_usdc = delta(wallet_usdc, wallet_of(env, &env.usdc, who.id()).await?);
    let in_wallet_wnear = delta(wallet_wnear, wallet_of(env, &env.wnear, who.id()).await?);
    Ok(Redeemed {
        shares,
        expected_usdc: pro_rata(usdc_before),
        expected_wnear: pro_rata(wnear_before),
        paid_usdc: in_wallet_usdc + delta(claim_usdc, claimable(env, who, "Usdc").await?),
        paid_wnear: in_wallet_wnear + delta(claim_wnear, claimable(env, who, "Wnear").await?),
        in_wallet_usdc,
        in_wallet_wnear,
        book_usdc_drop: -delta(usdc_before, usdc_after),
        book_wnear_drop: -delta(wnear_before, wnear_after),
        shares_drop: -delta(total_before, total_shares(env).await?),
        failure: refused_text(&result),
    })
}

/// Collects the steps of one attack and writes the proof before anything asserts.
pub struct Run {
    attack: &'static str,
    expected: &'static [&'static str],
    held: bool,
    steps: Vec<Value>,
    /// Behind a RefCell so `refused` can be called inside the arguments of `step`.
    observed: RefCell<Vec<String>>,
    notes: Vec<Value>,
    findings: Vec<Value>,
    refusals: RefCell<Vec<String>>,
}

/// The panic codes of SPEC 3.7 (the test in tests/test_attack_batch2.py keeps it equal to what the
/// vault panics with), plus `FROZEN` and `HALTED`, which the SPEC lists under `Rejected` and the
/// vault also panics with, and `NOT_ALLOWED`, which the SPEC dropped. Keeping that last one is a
/// tripwire: a vault that starts to emit it shows up as an unexpected code. A refusal that carries
/// one is recorded as observed whether or not the step says so, so the registry's code list is
/// checked against everything the run saw.
const SPEC_PANIC_CODES: &[&str] = &[
    "NOT_KEEPER",
    "NOT_ALLOWED",
    "NOT_IDLE",
    "COOLDOWN",
    "LOW_GAS",
    "NOT_STUCK",
    "TOO_EARLY",
    "BAD_SALT",
    "BAD_REVEAL",
    "ALREADY_REVEALED",
    "POLICY_NOT_TIGHTER",
    "POLICY_BELOW_FLOOR",
    "TIMELOCK",
    "OPS_BUDGET",
    "NOT_READY",
    "EXPIRED",
    "NOT_EXPIRED",
    "NOT_AWAITING",
    "NOT_STALE",
    "NEAR_RESERVE",
    "PARAMS_TOO_LONG",
    "FROZEN",
    "HALTED",
];

/// Whole codes in a message: runs of capital letters and underscores, so `NOT_EXPIRED` is never
/// read as `EXPIRED` and `POLICY_NOT_TIGHTER` is never read as `NOT_TIGHTER`.
fn codes_in(message: &str) -> Vec<&'static str> {
    let tokens: Vec<&str> = message
        .split(|c: char| !(c.is_ascii_uppercase() || c == '_'))
        .filter(|token| !token.is_empty())
        .collect();
    SPEC_PANIC_CODES
        .iter()
        .copied()
        .filter(|code| tokens.contains(code))
        .collect()
}

/// The message of a panic, or the kind of the error when it is not a panic.
fn refusal_message(text: &str) -> String {
    const PANIC: &str = "Smart contract panicked: ";
    if let Some(start) = text.find(PANIC) {
        let rest = &text[start + PANIC.len()..];
        return rest.split('"').next().unwrap_or(rest).to_string();
    }
    for kind in ["MethodNotFound", "AccountDoesNotExist"] {
        if text.contains(kind) {
            return kind.to_string();
        }
    }
    "other error".to_string()
}

impl Run {
    pub fn new(attack: &'static str, expected: &'static [&'static str]) -> Self {
        Self {
            attack,
            expected,
            held: true,
            steps: Vec::new(),
            observed: RefCell::new(Vec::new()),
            notes: Vec::new(),
            findings: Vec::new(),
            refusals: RefCell::new(Vec::new()),
        }
    }

    fn record(&self, code: &str) {
        let mut seen = self.observed.borrow_mut();
        if !seen.iter().any(|known| known == code) {
            seen.push(code.to_string());
        }
    }

    /// The text of a refused call, `None` when it went through. Every SPEC 3.7 panic code in it
    /// joins the observed codes, and any other message is listed in the proof as a refusal text.
    pub fn refused(&self, result: &ExecutionFinalResult) -> Option<String> {
        let text = refused_text(result)?;
        let message = refusal_message(&text);
        let codes = codes_in(&message);
        for code in &codes {
            self.record(code);
        }
        let mut refusals = self.refusals.borrow_mut();
        if codes.is_empty() && !refusals.contains(&message) {
            refusals.push(message);
        }
        Some(text)
    }

    pub fn step(&mut self, label: &str, held: bool, observed: Option<&str>, detail: Value) {
        self.held &= held;
        if let Some(code) = observed {
            self.record(code);
        }
        self.steps
            .push(json!({"step": label, "held": held, "observed": observed, "detail": detail}));
    }

    /// Evidence that is not a defence: setup and controls. If one of these is wrong the attack
    /// was never mounted, which is a tool error (no proof), so callers `ensure!` it first.
    pub fn context(&mut self, label: &str, detail: Value) {
        self.steps
            .push(json!({"step": label, "held": null, "observed": null, "detail": detail}));
    }

    /// Something the attack found that is not a defence of the vault and not a reason to fail the
    /// run: a property of the design the lead should decide on (threat model, deployment).
    pub fn finding(&mut self, id: &str, what: &str) {
        self.findings.push(json!({"id": id, "finding": what}));
    }

    pub fn note(&mut self, code: &str, why: &str) {
        self.notes.push(json!({"code": code, "note": why}));
    }

    pub fn finish(self, env: &Foundling, before: Value, after: Value) -> anyhow::Result<()> {
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
        let observed = self.observed.borrow().clone();
        let unexpected: Vec<&String> = observed
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
            "observed_codes": observed,
            "unexpected_codes": unexpected,
            "target": "local near-workspaces sandbox: the vault under contracts/vault with the mocks under contracts/mock-*",
            "vault_wasm_sha256": format!("{:x}", Sha256::digest(&wasm)),
            "policy": env.config["policy"],
            "ledger_before": before,
            "ledger_after": after,
            "steps": self.steps,
            "refusal_texts": self.refusals.borrow().clone(),
            "findings": self.findings,
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
