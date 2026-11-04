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
MAX_CLOSE_TRIES = 3
MAX_CONSECUTIVE_ERRORS = 100


class ConfigError(Exception):
    pass


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
    nonce_wait: int = 60
    policy_ttl: int = 60

    def __post_init__(self):
        if self.network == "mainnet" and not self.allow_mainnet:
            raise ConfigError("mainnet needs --allow-mainnet")
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


def summarize(logs, nonce):
    """The outcome of one cycle from the events its transactions emitted."""
    result, code, stuck, retries = "Unknown", None, False, 0
    for line in logs:
        if not line.startswith(EVENT_PREFIX):
            continue
        try:
            body = json.loads(line[len(EVENT_PREFIX):])
        except ValueError:
            continue
        data = (body.get("data") or [{}])[0]
        if body.get("standard") != "foundling" or data.get("nonce") != nonce:
            continue
        name, event_code = body.get("event"), data.get("code")
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
        self.state = {"last_trigger": saved.get("last_trigger", 0), "cycle": saved.get("cycle")}
        self.errors = 0
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
        stage = parse_stage(self.rpc.view(self.config.vault, "stage"))
        self._track(stage)
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
        if self.state["cycle"]:
            return self._close("Idle")
        if now < self.state["last_trigger"] + policy["cooldown"] + COOLDOWN_MARGIN:
            return "wait"
        if not self._due(("trigger",), now):
            return "wait"
        for flag, view in (("frozen", "is_frozen"), ("halted", "is_halted")):
            if self.rpc.view(self.config.vault, view):
                return self._note("skip", flag)
        if not self._prices_ok(policy):
            return self._note("skip", "price_null")
        return self._trigger(now)

    def _awaiting(self, stage, height, now, policy):
        stale = height >= stage.fields["entered_block"] + policy["abort_after_blocks"]
        key = ("abort", stage.nonce)
        if stale and self._due(key, now):
            self._send("abort_stale_cycle", {}, self.config.gas_light, key, now, self.config.retry_interval)
            return "abort"
        return "wait"

    def _ready(self, stage, now):
        nonce = stage.nonce
        if now >= stage.fields["expires_at"]:
            key = ("expire", nonce)
            if not self._due(key, now):
                return "wait"
            self._send("expire_decision", {}, self.config.gas_light, key, now, self.config.retry_interval)
            return "expire"
        key = ("execute", nonce)
        if not self._due(key, now):
            return "wait"
        for flag, view in (("frozen", "is_frozen"), ("halted", "is_halted")):
            if self.rpc.view(self.config.vault, view):
                return self._note("skip", flag)
        if not self._prices_ok(self._get_policy()):
            return self._note("skip", "price_null")
        self._send("execute_decision", {"nonce": nonce}, self.config.gas_execute, key, now,
                   self.config.retry_interval)
        return "execute"

    def _advance(self, stage, now, policy, since):
        key = ("advance", stage.kind, stage.nonce, stage.fields.get("attempt"), since)
        if not self._due(key, now):
            return "wait"
        self._send("advance", {"nonce": stage.nonce}, self.config.gas_advance, key, now,
                   policy["stuck_after"])
        return "advance"

    # actions -----------------------------------------------------------------------------
    def _trigger(self, now):
        before = self.rpc.view(self.config.vault, "last_nonce")
        started = self.clock()
        result = self.near.call(self.config.vault, "trigger_cycle", {}, self.config.gas_trigger)
        self._next_try[("trigger",)] = now + self.config.retry_interval
        maybe_landed = (result.error or "").startswith("timeout")
        if not result.ok and not maybe_landed:
            self._call_failed("trigger_cycle", {}, result)
            return "trigger_failed"
        nonce = self._wait_for_nonce(before)
        if nonce is None:
            self._call_failed("trigger_cycle", {}, result, "last_nonce did not move")
            return "trigger_failed"
        self.state["last_trigger"] = self.rpc.block()[1]
        txs = [{"method": "trigger_cycle", "hash": result.tx_hash}] if result.tx_hash else []
        self.state["cycle"] = {"nonce": nonce, "started": started, "txs": txs, "stages": [],
                               "resumed": False}
        self._save()
        return "trigger"

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
        result = self.near.call(self.config.vault, method, args, gas)
        self._next_try[key] = now + delay
        if result.tx_hash and self.state["cycle"]:
            self.state["cycle"]["txs"].append({"method": method, "hash": result.tx_hash})
            self._save()
        if not result.ok:
            self._call_failed(method, args, result)
        return result

    def _call_failed(self, method, args, result, reason=None):
        self.log.write({"kind": "call_failed", "at": iso(self.clock()), "method": method,
                        "args": args, "error": reason or result.error})

    # cycle bookkeeping ---------------------------------------------------------------------
    def _track(self, stage):
        if stage.kind == "Idle":
            return
        cycle = self.state["cycle"]
        if cycle and cycle["nonce"] != stage.nonce:
            self._close(stage.kind)
            cycle = None
        if not cycle:
            cycle = self.state["cycle"] = {"nonce": stage.nonce, "started": self.clock(), "txs": [],
                                           "stages": [], "resumed": True}
        if stage.kind not in cycle["stages"]:
            cycle["stages"].append(stage.kind)
            self._save()

    def _close(self, final_stage):
        cycle = self.state["cycle"]
        try:
            logs = [line for tx in cycle["txs"] if tx["hash"]
                    for line in self.rpc.tx_logs(tx["hash"], self.config.keeper_account)]
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
            "price_retries": outcome["price_retries"], "resumed": cycle["resumed"],
        })
        self.state["cycle"] = None
        self._next_try.clear()
        self._save()
        return "closed"

    # reads -------------------------------------------------------------------------------
    def _get_policy(self, force=False):
        wall = self.clock()
        if force or self._policy is None or wall - self._policy_at >= self.config.policy_ttl:
            self._policy = self.rpc.view(self.config.vault, "policy")
            self._policy_at = wall
        return self._policy

    def _prices_ok(self, policy):
        ids = [self._oracle["near_id"], self._oracle["usdc_id"]]
        try:
            feeds = self.rpc.view(self._oracle["account"], "list_prices_no_older_than",
                                  {"price_ids": ids, "age": policy["price_max_age"]})
        except ViewError:
            return False
        return all(feeds.get(feed_id) is not None for feed_id in ids)

    # small helpers -------------------------------------------------------------------------
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
