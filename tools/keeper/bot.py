"""The keeper state machine. Each `tick` reads the chain once and sends at most one call.

Time comes from the chain's final block, because the vault judges cooldown, expiry and
`stuck_after` in seconds of block time and `abort_after_blocks` in block height.
"""

import datetime
import json
from dataclasses import dataclass

from .rpc import RpcError, ViewError

# Mirrors MIN_TRIGGER_GAS, MIN_EXECUTE_GAS and MIN_ADVANCE_GAS in contracts/vault/src;
# tests/test_keeper_bot.py fails when they drift.
GAS_FLOORS = {"trigger_cycle": 250, "execute_decision": 240, "advance": 110}

AWAITING = ("AwaitingDecision", "AwaitingPrice")
TIMED = ("Depositing", "Swapping", "Withdrawing", "Probing")
TERMINAL = {
    "hold": "Hold", "cycle_failed": "CycleFailed", "rejected": "Rejected", "executed": "Executed",
    "swap_reverted": "SwapReverted", "cycle_aborted": "CycleAborted",
}
EVENT_PREFIX = "EVENT_JSON:"
COOLDOWN_MARGIN = 2
NOTE_EVERY = 600
NONCE_POLL = 2
SETTLE_GRACE = 30  # an Idle read with no stage seen yet is not trusted for this long after a trigger
MAX_CLOSE_TRIES = 3
MAX_CONSECUTIVE_ERRORS = 100
STALE_LIMIT = 6  # consecutive ticks whose block is behind the highest seen before that is doubted
MAX_BACKOFF = 600
ROLE_RECHECK_AFTER = 3  # failures of one method before the vault is asked who its keeper is


class ConfigError(Exception):
    pass


class GiveUp(Exception):
    """Too many calls in a row failed. Going on would only burn the keeper's gas."""


@dataclass
class Config:
    vault: str
    keeper_account: str
    network: str = "testnet"
    allow_mainnet: bool = False
    poll_interval: float = 5
    gas_trigger: int = 300
    gas_execute: int = 300
    gas_advance: int = 150
    gas_light: int = 50  # abort_stale_cycle and expire_decision have no gas minimum
    retry_interval: int = 30
    skip_interval: int = 15
    nonce_wait: int = 60
    policy_ttl: int = 60
    max_call_failures: int = 12

    def __post_init__(self):
        if self.network != "testnet" and not self.allow_mainnet:
            raise ConfigError(f"network {self.network!r} needs --allow-mainnet; only testnet is allowed without it")
        for field, method in (("gas_trigger", "trigger_cycle"), ("gas_execute", "execute_decision"),
                              ("gas_advance", "advance")):
            if getattr(self, field) < GAS_FLOORS[method]:
                raise ConfigError(f"{field} is below the contract minimum of {GAS_FLOORS[method]} TGas")


@dataclass
class Stage:
    kind: str
    fields: dict

    @property
    def nonce(self):
        return self.fields.get("nonce")


def parse_stage(raw):
    if isinstance(raw, str):
        return Stage(raw, {})
    ((kind, fields),) = raw.items()
    return Stage(kind, fields)


def _event_data(line):
    """(name, data) of a foundling event line, or None for anything else or anything malformed."""
    try:
        body = json.loads(line[len(EVENT_PREFIX):])
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get("standard") != "foundling":
        return None
    name, data = body.get("event"), body.get("data")
    if not isinstance(name, str) or not isinstance(data, list) or not data or not isinstance(data[0], dict):
        return None
    return name, data[0]


def summarize(logs, nonce):
    """The outcome of one cycle from the events its transactions emitted."""
    result, code, stuck, retries = "Unknown", None, False, 0
    for line in logs:
        if not isinstance(line, str) or not line.startswith(EVENT_PREFIX):
            continue
        event = _event_data(line)
        if event is None or event[1].get("nonce") != nonce:
            continue
        name, data = event
        event_code = data.get("code")
        if name == "stuck":
            stuck = True
        elif name == "rejected" and event_code == "PRICE_UNAVAILABLE":
            retries += 1
        elif name in TERMINAL:
            result, code = TERMINAL[name], event_code
    return {"result": result, "code": code, "stuck": stuck, "price_retries": retries}


def iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat(timespec="seconds")


class Bot:
    def __init__(self, config, rpc, near, sleep, clock, log, store):
        self.config, self.rpc, self.near = config, rpc, near
        self.sleep, self.clock, self.log, self.store = sleep, clock, log, store
        saved = store.load()
        if saved.get("vault") != config.vault:
            saved = {}  # state written for another vault says nothing about this one
        self.state = {"vault": config.vault, "last_trigger": saved.get("last_trigger", 0),
                      "cycle": saved.get("cycle"), "pending": saved.get("pending"),
                      "failures": saved.get("failures") or {"streak": 0, "methods": {}}}
        self._stale = 0
        self.errors = 0
        self._height = 0
        self._deposit = 0
        self._oracle = None
        self._policy = None
        self._policy_at = 0.0
        self._next_try = {}
        self._noted = (None, 0.0)

    # setup -------------------------------------------------------------------------------
    def preflight(self):
        roles = self.rpc.view(self.config.vault, "roles")
        if roles["keeper"] != self.config.keeper_account:
            raise ConfigError(f"the vault's keeper is {roles['keeper']}, not {self.config.keeper_account}")
        self._oracle = self.rpc.view(self.config.vault, "oracle")
        self._deposit = int(self.rpc.view(self.config.vault, "agent")["outlayer_deposit"])
        self._get_policy(force=True)

    def run(self, stop=lambda: False):
        while not stop():
            self.tick()
            if self.errors >= MAX_CONSECUTIVE_ERRORS:
                raise RpcError(f"{self.errors} ticks in a row failed")
            self.sleep(self.config.poll_interval)

    # one step ----------------------------------------------------------------------------
    def tick(self):
        try:
            action = self._tick()
        except RpcError as exc:
            self.errors += 1
            self._note("error", type(exc).__name__, error=str(exc)[:300])
            return "error"
        self.errors = 0
        return action

    def _tick(self):
        height, now = self.rpc.block()
        if height < self._height:
            self._stale += 1
            if self._stale < STALE_LIMIT:
                # Usually a node a block or two behind. Never stop for good on one wild reading.
                self._note("error", "stale_block", error=f"block {height} is behind {self._height}")
                return "stale"
        self._stale = 0
        self._height = height
        stage = parse_stage(self._read("stage"))
        self._track(stage, now)
        policy = self._get_policy()
        if stage.kind == "Idle":
            return self._idle(now, policy)
        if stage.kind in AWAITING:
            return self._awaiting(stage, height, now, policy)
        if stage.kind == "DecisionReady":
            return self._ready(stage, now)
        if stage.kind == "Stuck":
            return self._advance(stage, now, policy, since=stage.fields["since"])
        if stage.kind in TIMED and now >= stage.fields["entered_at"] + policy["stuck_after"]:
            return self._advance(stage, now, policy, since=stage.fields["entered_at"])
        return "wait"

    # stages ------------------------------------------------------------------------------
    def _idle(self, now, policy):
        cycle = self.state["cycle"]
        if cycle:
            # A node that has not seen the trigger yet also reads Idle.
            if cycle["stages"] or self.clock() >= cycle["started"] + SETTLE_GRACE:
                return self._close("Idle")
            return "wait"
        if self.state["pending"]:
            return self._settle_pending(self.state["pending"])
        if now < self.state["last_trigger"] + policy["cooldown"] + COOLDOWN_MARGIN:
            return "wait"
        key = ("trigger",)
        if not self._due(key, now) or self._blocked("trigger_cycle", now):
            return "wait"
        for flag, view in (("frozen", "is_frozen"), ("halted", "is_halted")):
            if self._read(view):
                return self._skip(flag, key, now)
        if int(self._read("ops_spent")) + self._deposit > int(policy["ops_budget"]):
            return self._skip("ops_budget", key, now)
        if not self._prices_ok(policy):
            return self._skip("price_null", key, now)
        return self._trigger(now)

    def _awaiting(self, stage, height, now, policy):
        stale = height >= stage.fields["entered_block"] + policy["abort_after_blocks"]
        key = ("abort", stage.nonce)
        if stale and self._due(key, now) and not self._blocked("abort_stale_cycle", now):
            self._send("abort_stale_cycle", {}, self.config.gas_light, key, now, self.config.retry_interval)
            return "abort"
        return "wait"

    def _ready(self, stage, now):
        nonce = stage.nonce
        if now >= stage.fields["expires_at"]:
            key = ("expire", nonce)
            if not self._due(key, now) or self._blocked("expire_decision", now):
                return "wait"
            self._send("expire_decision", {}, self.config.gas_light, key, now, self.config.retry_interval)
            return "expire"
        key = ("execute", nonce)
        if not self._due(key, now) or self._blocked("execute_decision", now):
            return "wait"
        for flag, view in (("frozen", "is_frozen"), ("halted", "is_halted")):
            if self._read(view):
                return self._skip(flag, key, now)
        # No oracle check here: if a feed is null the vault answers Rejected(PRICE_UNAVAILABLE),
        # which is recorded on chain, keeps the decision alive and costs one cheap call.
        self._send("execute_decision", {"nonce": nonce}, self.config.gas_execute, key, now,
                   self.config.retry_interval)
        return "execute"

    def _advance(self, stage, now, policy, since):
        # Not the attempt: a failed probe lands in Stuck again with attempt + 1 and the same
        # since, and that is the same window.
        key = ("advance", stage.nonce, since)
        if not self._due(key, now) or self._blocked("advance", now):
            return "wait"
        self._send("advance", {"nonce": stage.nonce}, self.config.gas_advance, key, now,
                   policy["stuck_after"])
        return "advance"

    # actions -----------------------------------------------------------------------------
    def _trigger(self, now):
        before = self._read("last_nonce")
        started = self.clock()
        result = self.near.call(self.config.vault, "trigger_cycle", {}, self.config.gas_trigger)
        spent = self.clock() - started
        self._next_try[("trigger",)] = now + spent + self.config.retry_interval
        maybe_landed = (result.error or "").startswith("timeout")
        if not result.ok and not maybe_landed:
            self._call_failed("trigger_cycle", {}, result)
            if "COOLDOWN" in (result.error or ""):
                # A trigger the bot did not see: wait one whole cooldown from here.
                self.state["last_trigger"] = now
                self._save()
            self._failed("trigger_cycle", now + spent)
            return "trigger_failed"
        txs = [{"method": "trigger_cycle", "hash": result.tx_hash}] if result.tx_hash else []
        # The RPC reads below can fail. Keep the hash first, so the cycle is still the bot's when
        # the next tick finds it, and is not logged Unknown with no transaction.
        self.state["pending"] = {"before": before, "started": started, "at": now, "txs": txs}
        self._save()
        nonce = self._wait_for_nonce(before)
        if nonce is None:
            self.state["pending"] = None
            self._call_failed("trigger_cycle", {}, result, "last_nonce did not move")
            self._failed("trigger_cycle", now + spent)
            return "trigger_failed"
        self._succeeded("trigger_cycle")
        height, seen_at = self.rpc.block()
        self._height = max(self._height, height)
        self.state["last_trigger"] = max(seen_at, now)
        self._adopt_pending(nonce)
        self._save()
        return "trigger"

    def _adopt_pending(self, nonce):
        """The trigger the bot sent becomes the cycle it follows."""
        pending, self.state["pending"] = self.state["pending"], None
        self.state["last_trigger"] = max(self.state["last_trigger"], pending["at"])
        self.state["cycle"] = {"nonce": nonce, "started": pending["started"], "txs": pending["txs"],
                               "stages": [], "resumed": False, "failed_calls": 0}

    def _settle_pending(self, pending):
        """Idle, with a trigger sent and its cycle never followed: it ended unseen, or never landed."""
        nonce = self._read("last_nonce")
        if nonce > pending["before"]:
            self._adopt_pending(nonce)
            return self._close("Idle")
        if self.clock() >= pending["started"] + SETTLE_GRACE:
            self.state["pending"] = None
            self._save()
        return "wait"

    def _wait_for_nonce(self, before):
        deadline = self.clock() + self.config.nonce_wait
        while True:
            nonce = self.rpc.view(self.config.vault, "last_nonce")
            if nonce > before:
                return nonce
            if self.clock() >= deadline:
                return None
            self.sleep(NONCE_POLL)

    def _send(self, method, args, gas, key, now, delay):
        started = self.clock()
        result = self.near.call(self.config.vault, method, args, gas)
        spent = self.clock() - started  # a call can block for minutes; the spacing starts after it
        self._next_try[key] = now + spent + delay
        cycle = self.state["cycle"]
        if result.tx_hash and cycle:
            cycle["txs"].append({"method": method, "hash": result.tx_hash})
            self._save()
        if result.ok:
            self._succeeded(method)
        else:
            if cycle:
                cycle["failed_calls"] = cycle.get("failed_calls", 0) + 1
            self._call_failed(method, args, result)
            self._failed(method, now + spent)
        return result

    def _call_failed(self, method, args, result, reason=None):
        self.log.write({"kind": "call_failed", "at": iso(self.clock()), "method": method,
                        "args": args, "error": reason or result.error})

    # cycle bookkeeping ---------------------------------------------------------------------
    def _track(self, stage, now):
        if stage.kind == "Idle":
            return
        cycle = self.state["cycle"]
        if cycle and cycle["nonce"] != stage.nonce:
            self._close("Unobserved")
            cycle = None
        pending = self.state["pending"]
        if not cycle and pending and stage.nonce > pending["before"]:
            self._adopt_pending(stage.nonce)
            cycle = self.state["cycle"]
        if not cycle:
            # Someone else's trigger, or one this bot lost track of: its cooldown still runs.
            self.state["last_trigger"] = max(self.state["last_trigger"], now)
            cycle = self.state["cycle"] = {"nonce": stage.nonce, "started": self.clock(), "txs": [],
                                           "stages": [], "resumed": True, "failed_calls": 0}
        if stage.kind not in cycle["stages"]:
            cycle["stages"].append(stage.kind)
            self._save()

    def _close(self, final_stage):
        cycle = self.state["cycle"]
        try:
            logs = [line for tx in cycle["txs"] if tx["hash"]
                    for line in self.rpc.tx_logs(tx["hash"], self.config.keeper_account,
                                                 executor=self.config.vault)]
            outcome = summarize(logs, cycle["nonce"])
        except RpcError:
            cycle["close_tries"] = cycle.get("close_tries", 0) + 1
            if cycle["close_tries"] < MAX_CLOSE_TRIES:
                self._save()
                raise
            outcome = {"result": "Unknown", "code": None, "stuck": False, "price_retries": 0}
        ended = self.clock()
        self.log.write({
            "kind": "cycle", "vault": self.config.vault, "nonce": cycle["nonce"],
            "final_stage": final_stage, "result": outcome["result"], "code": outcome["code"],
            "txs": cycle["txs"], "duration_s": round(ended - cycle["started"], 1),
            "started_at": iso(cycle["started"]), "ended_at": iso(ended),
            "stages_seen": cycle["stages"],
            "stuck": outcome["stuck"] or "Stuck" in cycle["stages"],
            "price_retries": outcome["price_retries"], "failed_calls": cycle.get("failed_calls", 0),
            "resumed": cycle["resumed"],
        })
        self.state["cycle"] = None
        self._next_try.clear()
        self._save()
        return "closed"

    # reads -------------------------------------------------------------------------------
    def _read(self, method, args=None, account=None):
        return self.rpc.view(account or self.config.vault, method, args, block_id=self._height or None)

    def _get_policy(self, force=False):
        wall = self.clock()
        if force or self._policy is None or wall - self._policy_at >= self.config.policy_ttl:
            self._policy = self._read("policy")
            self._policy_at = wall
        return self._policy

    def _prices_ok(self, policy):
        ids = [self._oracle["near_id"], self._oracle["usdc_id"]]
        try:
            feeds = self._read("list_prices_no_older_than",
                               {"price_ids": ids, "age": policy["price_max_age"]},
                               account=self._oracle["account"])
        except ViewError:
            return False
        return all(feeds.get(feed_id) is not None for feed_id in ids)

    # failures ----------------------------------------------------------------------------
    def _blocked(self, method, now):
        return now < self.state["failures"]["methods"].get(method, {}).get("until", 0)

    def _failed(self, method, at):
        """A call failed: back off exponentially, notice a rotated keeper, and in the end stop."""
        failures = self.state["failures"]
        entry = failures["methods"].setdefault(method, {"count": 0, "until": 0})
        entry["count"] += 1
        failures["streak"] += 1
        entry["until"] = at + min(self.config.retry_interval * 2 ** (entry["count"] - 1), MAX_BACKOFF)
        self._save()
        if entry["count"] >= ROLE_RECHECK_AFTER:
            keeper = self.rpc.view(self.config.vault, "roles")["keeper"]
            if keeper != self.config.keeper_account:
                raise ConfigError(f"the vault's keeper is now {keeper}, not {self.config.keeper_account}")
        if failures["streak"] >= self.config.max_call_failures:
            raise GiveUp(f"{failures['streak']} calls in a row failed; the last was {method}")

    def _succeeded(self, method):
        failures = self.state["failures"]
        failures["methods"].pop(method, None)
        failures["streak"] = 0
        self._save()

    # small helpers -------------------------------------------------------------------------
    def _skip(self, reason, key, now):
        self._next_try[key] = now + self.config.skip_interval
        return self._note("skip", reason)

    def _due(self, key, now):
        return now >= self._next_try.get(key, 0)

    def _save(self):
        self.store.save(self.state)

    def _note(self, kind, reason, **extra):
        """Log a repeated condition when it changes or every NOTE_EVERY seconds."""
        wall = self.clock()
        last_key, last_at = self._noted
        if last_key != (kind, reason) or wall - last_at >= NOTE_EVERY:
            self.log.write({"kind": kind, "at": iso(wall), "reason": reason, **extra})
            self._noted = ((kind, reason), wall)
        return f"{kind}:{reason}"
