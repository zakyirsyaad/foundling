"""A small model of the vault for keeper tests: stages, panics, events and oracle feeds.

It stands in for both the RPC wrapper and the near-cli wrapper, and it owns the clock, so
`sleep` moves time and fires the callbacks that are due. One block per second.
"""

import json

from tools.keeper.near_cli import CallResult
from tools.keeper.rpc import ViewError

VAULT = "vault.test"
KEEPER = "keeper.test"
ORACLE = "oracle.test"
NEAR_ID = "near-id"
USDC_ID = "usdc-id"

GAS_FLOORS = {"trigger_cycle": 250, "execute_decision": 240, "advance": 110}


def event_line(name, **data):
    body = {"standard": "foundling", "version": "1.0.0", "event": name, "data": [data]}
    return "EVENT_JSON:" + json.dumps(body, separators=(",", ":"))


class World:
    def __init__(self, **policy):
        self.now = 1_000_000.0
        self.height = 5_000
        self.stage = "Idle"
        self.last_nonce = 0
        self.last_trigger = 0
        self.frozen = False
        self.halted = False
        self.keeper = KEEPER
        self.policy = {
            "cooldown": 60, "stuck_after": 120, "abort_after_blocks": 450,
            "decision_ttl": 600, "price_max_age": 120, "ops_budget": str(10**9), **policy,
        }
        self.ops_spent = 0
        self.force_panic = {}  # method -> reason, for failures the model does not know
        self.outlayer_deposit = 50
        self.stale_stage = []  # values the next `stage` views return instead of the truth
        self.stale_blocks = []  # (height, time) pairs the next `block` calls return
        self.view_log = []  # (account, method, block_id)
        self.feeds = {NEAR_ID: True, USDC_ID: True}
        self.trigger_result = "ready"  # ready | hold | null | never
        self.decision_delay = 10
        self.execute_script = []  # PRICE_UNAVAILABLE | REJECT:<code> | EXECUTED | STUCK
        self.advance_mode = "success"  # success | noop | stay_stuck
        self.price_delay = 3  # seconds from execute_decision to the oracle callback
        self.price_hang = False  # the callback never arrives
        self.call_duration = 0  # seconds near-cli blocks after sending, as it does while a yield runs
        self.tx_log_executors = []  # the executor filter each tx_logs call asked for
        self.calls = []  # dicts: t, method, args, gas, ok, error, hash
        self.logs = {}
        self.timeline = []
        self._tx = 0
        self.near = _WorldNear(self)

    # clock ---------------------------------------------------------------------------
    def sleep(self, seconds):
        end = self.now + seconds
        while True:
            due = sorted((item for item in self.timeline if item[0] <= end), key=lambda i: i[0])
            if not due:
                break
            when, fn = due[0]
            self.timeline.remove(due[0])
            self.height += int(max(when - self.now, 0))
            self.now = max(self.now, when)
            fn()
        self.height += int(max(end - self.now, 0))
        self.now = end

    def clock(self):
        return self.now

    def at(self, delay, fn):
        self.timeline.append((self.now + delay, fn))

    # state helpers for tests -----------------------------------------------------------
    def set_stage(self, kind, **fields):
        self.stage = "Idle" if kind == "Idle" else {kind: fields}

    def kind(self):
        return "Idle" if self.stage == "Idle" else next(iter(self.stage))

    def fields(self):
        return {} if self.stage == "Idle" else next(iter(self.stage.values()))

    def null_feed(self, feed_id=NEAR_ID):
        self.feeds[feed_id] = None

    def methods(self, name):
        return [c for c in self.calls if c["method"] == name]

    # rpc side ---------------------------------------------------------------------------
    def block(self):
        if self.stale_blocks:
            return self.stale_blocks.pop(0)
        return self.height, int(self.now)

    def tx_logs(self, tx_hash, signer, executor=None):
        self.tx_log_executors.append(executor)
        return list(self.logs[tx_hash])

    def view(self, account, method, args=None, block_id=None):
        self.view_log.append((account, method, block_id))
        if method == "stage" and self.stale_stage:
            return self.stale_stage.pop(0)
        if account == ORACLE and method == "list_prices_no_older_than":
            return {i: ({"price": "1", "conf": "0", "expo": -8, "publish_time": int(self.now)}
                        if self.feeds.get(i) else None) for i in args["price_ids"]}
        if account != VAULT:
            raise ViewError(f"unknown account {account}")
        views = {
            "stage": lambda: self.stage,
            "last_nonce": lambda: self.last_nonce,
            "policy": lambda: dict(self.policy),
            "is_frozen": lambda: self.frozen,
            "is_halted": lambda: self.halted,
            "ops_spent": lambda: str(self.ops_spent),
            "agent": lambda: {"outlayer_deposit": str(self.outlayer_deposit)},
            "oracle": lambda: {"account": ORACLE, "near_id": NEAR_ID, "usdc_id": USDC_ID},
            "roles": lambda: {"governor": "gov.test", "keeper": self.keeper, "guardian": "guard.test"},
        }
        if method not in views:
            raise ViewError(f"unknown view {method}")
        return views[method]()

    # near side: the contract ---------------------------------------------------------------
    def apply(self, method, args, gas):
        record = {"t": self.now, "method": method, "args": args, "gas": gas, "ok": True,
                  "error": None, "hash": None}
        self.calls.append(record)
        try:
            tx_hash = self._enter(method, args, gas)
        except Panic as panic:
            record.update(ok=False, error=f"Smart contract panicked: {panic}")
            return CallResult(False, None, record["error"])
        record["hash"] = tx_hash
        return CallResult(True, tx_hash)

    def _new_tx(self):
        self._tx += 1
        tx_hash = f"TX{self._tx}"
        self.logs[tx_hash] = []
        return tx_hash

    def _emit(self, tx_hash, name, **data):
        self.logs[tx_hash].append(event_line(name, **data))

    def _enter(self, method, args, gas):
        if method in self.force_panic:
            raise Panic(self.force_panic[method])
        if gas < GAS_FLOORS.get(method, 0):
            raise Panic("LOW_GAS")
        return getattr(self, "_" + method)(args)

    def _trigger_cycle(self, args):
        if self.kind() != "Idle":
            raise Panic("NOT_IDLE")
        if self.frozen:
            raise Panic("FROZEN")
        if self.halted:
            raise Panic("HALTED")
        if self.last_trigger and self.now < self.last_trigger + self.policy["cooldown"]:
            raise Panic("COOLDOWN")
        if self.ops_spent + self.outlayer_deposit > int(self.policy["ops_budget"]):
            raise Panic("OPS_BUDGET")
        tx = self._new_tx()
        self.ops_spent += self.outlayer_deposit
        self.last_trigger = self.now
        self.last_nonce += 1
        nonce = self.last_nonce
        self.stage = {"AwaitingDecision": {"nonce": nonce, "entered_block": self.height}}
        self._emit(tx, "cycle_started", nonce=nonce)
        self.at(self.decision_delay, lambda: self._decision_arrives(tx, nonce))
        return tx

    def _decision_arrives(self, tx, nonce):
        if self.kind() != "AwaitingDecision" or self.fields()["nonce"] != nonce:
            return
        result = self.trigger_result
        if result == "ready":
            self.stage = {"DecisionReady": {"nonce": nonce,
                                            "expires_at": int(self.now) + self.policy["decision_ttl"]}}
            self._emit(tx, "decision_ready", nonce=nonce)
        elif result == "hold":
            self._emit(tx, "hold", nonce=nonce, code="NO_DECISION")
            self.stage = "Idle"
        elif result == "null":
            self._emit(tx, "cycle_failed", nonce=nonce, code="NULL_RESULT")
            self.stage = "Idle"

    def _execute_decision(self, args):
        nonce = args["nonce"]
        if self.kind() != "DecisionReady" or self.fields()["nonce"] != nonce:
            raise Panic("NOT_READY")
        expires_at = self.fields()["expires_at"]
        if self.now >= expires_at:
            raise Panic("EXPIRED")
        if self.frozen:
            raise Panic("FROZEN")
        tx = self._new_tx()
        step = self.execute_script.pop(0) if self.execute_script else "EXECUTED"
        self.stage = {"AwaitingPrice": {"nonce": nonce, "entered_block": self.height,
                                        "expires_at": expires_at}}
        if not self.price_hang:
            self.at(self.price_delay, lambda: self._price_arrives(tx, nonce, expires_at, step))
        return tx

    def _price_arrives(self, tx, nonce, expires_at, step):
        if self.kind() != "AwaitingPrice" or self.fields()["nonce"] != nonce:
            return
        if step == "EXECUTED" and not all(self.feeds.values()):
            step = "PRICE_UNAVAILABLE"  # the vault reads the same oracle the bot looked at
        if step == "PRICE_UNAVAILABLE":
            self._emit(tx, "rejected", nonce=nonce, code="PRICE_UNAVAILABLE")
            self.stage = {"DecisionReady": {"nonce": nonce, "expires_at": expires_at}}
        elif step.startswith("REJECT:"):
            self._emit(tx, "rejected", nonce=nonce, code=step.split(":", 1)[1])
            self.stage = "Idle"
        else:
            self.stage = {"Swapping": {"nonce": nonce, "attempt": 0, "entered_at": int(self.now)}}
            self._emit(tx, "swap_started", nonce=nonce)
            if step == "EXECUTED":
                self.at(15, lambda: self._swap_done(tx, nonce))
            else:
                self.at(15, lambda: self._swap_stuck(tx, nonce))

    def _swap_done(self, tx, nonce):
        if self.kind() == "Swapping" and self.fields()["nonce"] == nonce:
            self._emit(tx, "executed", nonce=nonce, amount_in="1", amount_out="1")
            self.stage = "Idle"

    def _swap_stuck(self, tx, nonce):
        if self.kind() == "Swapping" and self.fields()["nonce"] == nonce:
            self._emit(tx, "stuck", nonce=nonce, step="Swap")
            self.stage = {"Stuck": {"nonce": nonce, "step": "Swap", "attempt": 0,
                                    "since": int(self.now)}}

    def _advance(self, args):
        nonce = args["nonce"]
        kind, fields = self.kind(), self.fields()
        timed_out = "entered_at" in fields and self.now >= fields["entered_at"] + self.policy["stuck_after"]
        eligible = kind == "Stuck" or (kind in ("Depositing", "Swapping", "Withdrawing", "Probing") and timed_out)
        if not eligible or fields.get("nonce") != nonce:
            raise Panic("NOT_STUCK")
        tx = self._new_tx()
        if self.advance_mode != "noop":
            attempt = fields.get("attempt", 0) + 1
            self.stage = {"Probing": {"nonce": nonce, "step": fields.get("step", "Swap"),
                                      "attempt": attempt, "stuck_since": int(self.now),
                                      "entered_at": int(self.now)}}
            self._emit(tx, "probing", nonce=nonce, attempt=attempt)

            since = fields.get("since", fields.get("stuck_since", int(self.now)))

            def finish():
                if self.advance_mode == "stay_stuck":
                    self._emit(tx, "stuck", nonce=nonce, step="Swap")
                    self.stage = {"Stuck": {"nonce": nonce, "step": "Swap", "attempt": attempt,
                                            "since": since}}
                    return
                self._emit(tx, "executed", nonce=nonce, amount_in="1", amount_out="1")
                self.stage = "Idle"

            self.at(15, finish)
        return tx

    def _abort_stale_cycle(self, args):
        if self.kind() not in ("AwaitingDecision", "AwaitingPrice"):
            raise Panic("NOT_AWAITING")
        if self.height < self.fields()["entered_block"] + self.policy["abort_after_blocks"]:
            raise Panic("NOT_STALE")
        tx = self._new_tx()
        self._emit(tx, "cycle_aborted", nonce=self.fields()["nonce"])
        self.stage = "Idle"
        return tx

    def _expire_decision(self, args):
        if self.kind() != "DecisionReady" or self.now < self.fields()["expires_at"]:
            raise Panic("NOT_EXPIRED")
        tx = self._new_tx()
        self._emit(tx, "cycle_failed", nonce=self.fields()["nonce"], code="EXPIRED")
        self.stage = "Idle"
        return tx


class Panic(Exception):
    pass


class _WorldNear:
    def __init__(self, world):
        self.world = world

    def call(self, contract, method, args, gas_tgas):
        assert contract == VAULT, contract
        result = self.world.apply(method, args, gas_tgas)
        if self.world.call_duration:
            self.world.sleep(self.world.call_duration)
        return result


class MemoryStore:
    def __init__(self, data=None):
        self.data = data or {}

    def load(self):
        return json.loads(json.dumps(self.data))

    def save(self, data):
        self.data = json.loads(json.dumps(data))


class ListLog:
    def __init__(self):
        self.lines = []

    def write(self, record):
        self.lines.append(json.loads(json.dumps(record)))

    def of(self, kind):
        return [line for line in self.lines if line["kind"] == kind]
