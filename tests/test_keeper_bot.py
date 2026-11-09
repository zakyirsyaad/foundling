"""The keeper state machine against a model vault. No network, no real clock, no near-cli."""

import re
import unittest
from pathlib import Path

from tests.keeper_fakes import GAS_FLOORS as WORLD_FLOORS
from tests.keeper_fakes import KEEPER, NEAR_ID, USDC_ID, VAULT, ListLog, MemoryStore, World
from tools.keeper.bot import GAS_FLOORS, Bot, Config, ConfigError, GiveUp, summarize
from tools.keeper.near_cli import CallResult
from tools.keeper.rpc import RpcError

ROOT = Path(__file__).resolve().parent.parent


def make_bot(world, store=None, log=None, **overrides):
    config = Config(vault=VAULT, keeper_account=KEEPER, **overrides)
    bot = Bot(config, rpc=world, near=world.near, sleep=world.sleep, clock=world.clock,
              log=log if log is not None else ListLog(),
              store=store if store is not None else MemoryStore())
    bot.preflight()
    return bot


def drive(bot, world, seconds):
    end = world.now + seconds
    while world.now < end:
        bot.tick()
        world.sleep(bot.config.poll_interval)


class TriggerTest(unittest.TestCase):
    def test_skips_trigger_when_price_feed_null(self):
        world = World()
        world.null_feed(NEAR_ID)
        log = ListLog()
        drive(make_bot(world, log=log), world, 60)
        self.assertEqual(world.methods("trigger_cycle"), [])
        self.assertEqual(log.of("skip")[0]["reason"], "price_null")

    def test_one_null_feed_is_enough_to_hold_the_trigger(self):
        world = World()
        world.null_feed(USDC_ID)
        drive(make_bot(world), world, 30)
        self.assertEqual(world.methods("trigger_cycle"), [])

    def test_respects_cooldown(self):
        world = World(cooldown=60)
        world.trigger_result = "hold"
        bot = make_bot(world)
        drive(bot, world, 40)
        self.assertEqual(len(world.methods("trigger_cycle")), 1)
        drive(bot, world, 40)
        triggers = world.methods("trigger_cycle")
        self.assertEqual(len(triggers), 2)
        self.assertGreaterEqual(triggers[1]["t"], triggers[0]["t"] + 60)
        self.assertTrue(all(call["ok"] for call in world.calls), "the cooldown was held, not burned")

    def test_a_frozen_or_halted_vault_is_not_triggered(self):
        for flag in ("frozen", "halted"):
            with self.subTest(flag):
                world = World()
                setattr(world, flag, True)
                log = ListLog()
                drive(make_bot(world, log=log), world, 30)
                self.assertEqual(world.methods("trigger_cycle"), [])
                self.assertEqual(log.of("skip")[0]["reason"], flag)

    def test_trigger_uses_the_configured_gas(self):
        world = World()
        drive(make_bot(world, gas_trigger=280), world, 10)
        self.assertEqual(world.methods("trigger_cycle")[0]["gas"], 280)


class ExecuteTest(unittest.TestCase):
    def test_retries_price_unavailable_without_new_trigger(self):
        world = World(cooldown=3600)
        world.execute_script = ["PRICE_UNAVAILABLE", "EXECUTED"]
        log = ListLog()
        drive(make_bot(world, log=log, retry_interval=30), world, 200)
        self.assertEqual(len(world.methods("trigger_cycle")), 1)
        executes = world.methods("execute_decision")
        self.assertEqual(len(executes), 2)
        self.assertEqual([c["args"] for c in executes], [{"nonce": 1}, {"nonce": 1}])
        self.assertGreaterEqual(executes[1]["t"], executes[0]["t"] + 30)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["price_retries"]), ("Executed", 1))

    def test_execute_is_not_gated_on_the_oracle_so_the_vault_records_the_rejection(self):
        world = World()
        world.set_stage("DecisionReady", nonce=1, expires_at=int(world.now) + 600)
        world.null_feed(NEAR_ID)
        bot = make_bot(world, retry_interval=30)
        drive(bot, world, 100)
        executes = world.methods("execute_decision")
        self.assertGreaterEqual(len(executes), 3, "it keeps trying while the decision lives")
        self.assertTrue(all(b["t"] - a["t"] >= 30 for a, b in zip(executes, executes[1:])))
        self.assertEqual(world.kind(), "DecisionReady", "PRICE_UNAVAILABLE does not end the cycle")
        world.feeds[NEAR_ID] = True
        drive(bot, world, 40)
        executed = [line for lines in world.logs.values() for line in lines if '"event":"executed"' in line]
        self.assertTrue(executed, "once the feed is back the swap goes through")

    def test_a_frozen_vault_is_not_sent_an_execute(self):
        world = World()
        world.set_stage("DecisionReady", nonce=1, expires_at=int(world.now) + 600)
        world.frozen = True
        drive(make_bot(world), world, 30)
        self.assertEqual(world.methods("execute_decision"), [])

    def test_rejected_price_wide_ends_the_cycle_with_its_code(self):
        world = World(cooldown=3600)
        world.execute_script = ["REJECT:PRICE_WIDE"]
        log = ListLog()
        drive(make_bot(world, log=log), world, 90)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"]), ("Rejected", "PRICE_WIDE"))


class RecoveryTest(unittest.TestCase):
    def test_calls_advance_when_stuck_past_threshold(self):
        world = World(stuck_after=120)
        world.advance_mode = "noop"
        world.set_stage("Swapping", nonce=7, attempt=0, entered_at=int(world.now))
        bot = make_bot(world)
        drive(bot, world, 100)
        self.assertEqual(world.methods("advance"), [], "not stuck yet")
        drive(bot, world, 40)
        (call,) = world.methods("advance")
        self.assertEqual(call["args"], {"nonce": 7})
        self.assertGreaterEqual(call["gas"], GAS_FLOORS["advance"])
        drive(bot, world, 100)
        self.assertEqual(len(world.methods("advance")), 1, "once per window")
        drive(bot, world, 100)
        self.assertEqual(len(world.methods("advance")), 2, "a new window allows one more")

    def test_a_stuck_stage_is_advanced_at_once_with_the_right_nonce(self):
        world = World()
        world.set_stage("Stuck", nonce=9, step="Swap", attempt=0, since=int(world.now) - 10)
        drive(make_bot(world), world, 10)
        self.assertEqual([c["args"] for c in world.methods("advance")], [{"nonce": 9}])

    def test_a_cycle_that_got_stuck_is_recorded_as_such(self):
        world = World(cooldown=3600)
        world.execute_script = ["STUCK"]
        log = ListLog()
        drive(make_bot(world, log=log), world, 150)
        (cycle,) = log.of("cycle")
        self.assertTrue(cycle["stuck"])
        self.assertEqual(cycle["result"], "Executed")
        self.assertEqual([t["method"] for t in cycle["txs"]],
                         ["trigger_cycle", "execute_decision", "advance"])

    def test_aborts_stale_awaiting_decision(self):
        world = World(cooldown=3600, abort_after_blocks=450)
        world.trigger_result = "never"
        log = ListLog()
        bot = make_bot(world, log=log)
        drive(bot, world, 400)
        self.assertEqual(world.methods("abort_stale_cycle"), [])
        drive(bot, world, 100)
        self.assertEqual(len(world.methods("abort_stale_cycle")), 1)
        self.assertEqual(log.of("cycle")[0]["result"], "CycleAborted")

    def test_aborts_a_stale_awaiting_price(self):
        world = World(cooldown=3600, abort_after_blocks=450)
        world.price_hang = True  # the oracle callback never arrives
        log = ListLog()
        bot = make_bot(world, log=log)
        drive(bot, world, 400)
        self.assertEqual(world.kind(), "AwaitingPrice")
        self.assertEqual(world.methods("abort_stale_cycle"), [])
        drive(bot, world, 150)
        self.assertEqual(len(world.methods("abort_stale_cycle")), 1)
        self.assertEqual(len(world.methods("execute_decision")), 1, "no second execute while it waits")
        (cycle,) = log.of("cycle")
        self.assertEqual(cycle["result"], "CycleAborted")
        self.assertIn("AwaitingPrice", cycle["stages_seen"])

    def test_expires_decision_past_expires_at(self):
        world = World()
        expires_at = int(world.now) + 100
        world.set_stage("DecisionReady", nonce=4, expires_at=expires_at)
        world.null_feed(NEAR_ID)
        bot = make_bot(world)
        drive(bot, world, 90)
        self.assertEqual(world.methods("expire_decision"), [])
        drive(bot, world, 30)
        self.assertEqual(len(world.methods("expire_decision")), 1)
        self.assertTrue(all(c["t"] < expires_at for c in world.methods("execute_decision")),
                        "nothing is executed once the decision has expired")


class CycleLogTest(unittest.TestCase):
    def test_a_hold_is_one_line_with_nonce_stage_code_tx_and_duration(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        log = ListLog()
        drive(make_bot(world, log=log), world, 60)
        (cycle,) = log.of("cycle")
        self.assertEqual(cycle["nonce"], 1)
        self.assertEqual(cycle["final_stage"], "Idle")
        self.assertEqual((cycle["result"], cycle["code"]), ("Hold", "NO_DECISION"))
        self.assertEqual(cycle["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])
        self.assertGreaterEqual(cycle["duration_s"], 10)
        self.assertFalse(cycle["stuck"])

    def test_a_failed_worker_run_is_recorded_as_null_result(self):
        world = World(cooldown=3600)
        world.trigger_result = "null"
        log = ListLog()
        drive(make_bot(world, log=log), world, 60)
        self.assertEqual((log.of("cycle")[0]["result"], log.of("cycle")[0]["code"]),
                         ("CycleFailed", "NULL_RESULT"))

    def test_an_open_cycle_survives_a_restart(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        store, log = MemoryStore(), ListLog()
        make_bot(world, store=store, log=log).tick()
        self.assertEqual(world.kind(), "AwaitingDecision")
        drive(make_bot(world, store=store, log=log), world, 60)
        (cycle,) = log.of("cycle")
        self.assertEqual(cycle["txs"][0]["hash"], "TX1")
        self.assertEqual(len(world.methods("trigger_cycle")), 1)

    def test_a_cooldown_panic_backs_off_a_full_cooldown(self):
        world = World(cooldown=3600)
        world.last_trigger = world.now - 10  # a trigger the bot cannot know about
        log = ListLog()
        drive(make_bot(world, log=log, retry_interval=30), world, 600)
        self.assertEqual(len([c for c in world.calls if not c["ok"]]), 1, "not retried every 30 s")
        (failure,) = log.of("call_failed")
        self.assertIn("COOLDOWN", failure["error"])

    def test_other_failed_calls_retry_once_per_interval(self):
        world = World(cooldown=60)
        world.force_panic["trigger_cycle"] = "SOME_NEW_REASON"
        log = ListLog()
        drive(make_bot(world, log=log, retry_interval=30), world, 60)
        self.assertEqual(len([c for c in world.calls if not c["ok"]]), 2)
        self.assertEqual(len(log.of("call_failed")), 2)

    def test_a_resumed_cycle_starts_the_cooldown(self):
        world = World(cooldown=60)
        world.set_stage("AwaitingDecision", nonce=1, entered_block=world.height)
        world.at(10, lambda: setattr(world, "stage", "Idle"))
        bot = make_bot(world)
        drive(bot, world, 50)
        self.assertEqual(world.methods("trigger_cycle"), [])
        drive(bot, world, 40)
        self.assertEqual(len(world.methods("trigger_cycle")), 1)
        self.assertTrue(world.methods("trigger_cycle")[0]["ok"])

    def test_a_stale_idle_read_does_not_close_a_cycle_that_just_started(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        world.decision_delay = 30
        log = ListLog()
        bot = make_bot(world, log=log)
        bot.tick()
        world.stale_stage = ["Idle"]
        drive(bot, world, 60)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["resumed"]), ("Hold", False))
        self.assertEqual(cycle["txs"][0]["hash"], "TX1")

    def test_a_block_older_than_one_already_seen_skips_the_tick(self):
        world = World()
        world.set_stage("Swapping", nonce=7, attempt=0, entered_at=int(world.now))
        bot = make_bot(world)
        bot.tick()
        world.stale_blocks = [(world.height - 50, int(world.now) - 50)]
        calls_before = len(world.view_log)
        self.assertEqual(bot.tick(), "stale")
        self.assertEqual(world.view_log[calls_before:], [], "no view is read at a stale height")

    def test_views_are_pinned_to_the_block_the_tick_started_from(self):
        world = World()
        bot = make_bot(world)
        world.view_log.clear()
        bot.tick()
        stage_reads = [entry for entry in world.view_log if entry[1] == "stage"]
        self.assertEqual([entry[2] for entry in stage_reads], [world.height])

    def test_a_cycle_replaced_by_another_is_closed_as_unobserved(self):
        world = World()
        world.set_stage("Swapping", nonce=2, attempt=0, entered_at=int(world.now))
        store = MemoryStore({"vault": VAULT, "last_trigger": 0, "cycle": {
            "nonce": 1, "started": world.now - 99, "txs": [], "stages": [], "resumed": False}})
        log = ListLog()
        make_bot(world, store=store, log=log).tick()
        self.assertEqual(log.of("cycle")[0]["final_stage"], "Unobserved")

    def test_state_saved_for_another_vault_is_ignored(self):
        world = World()
        store = MemoryStore({"vault": "other.test", "last_trigger": 5, "cycle": {
            "nonce": 9, "started": 0, "txs": [], "stages": [], "resumed": False}})
        bot = make_bot(world, store=store)
        self.assertIsNone(bot.state["cycle"])
        self.assertEqual(bot.state["last_trigger"], 0)

    def test_a_skipped_check_is_not_repeated_every_tick(self):
        world = World()
        world.null_feed(NEAR_ID)
        drive(make_bot(world), world, 60)
        oracle_reads = [e for e in world.view_log if e[1] == "list_prices_no_older_than"]
        self.assertLessEqual(len(oracle_reads), 5)


class OpsBudgetTest(unittest.TestCase):
    def test_does_not_trigger_when_the_ops_budget_would_be_exceeded(self):
        world = World(ops_budget="100")
        world.ops_spent = 60  # 60 + 50 per cycle > 100
        log = ListLog()
        bot = make_bot(world, log=log)
        drive(bot, world, 30)
        self.assertEqual(world.methods("trigger_cycle"), [])
        self.assertEqual(log.of("skip")[0]["reason"], "ops_budget")
        world.ops_spent = 0
        drive(bot, world, 30)
        self.assertEqual(len(world.methods("trigger_cycle")), 1)


class AdvanceWindowTest(unittest.TestCase):
    def test_advance_stays_throttled_when_every_probe_ends_back_in_stuck(self):
        world = World(stuck_after=600)
        world.advance_mode = "stay_stuck"
        world.set_stage("Stuck", nonce=3, step="Swap", attempt=0, since=int(world.now) - 5)
        drive(make_bot(world), world, 1800)
        sent = world.methods("advance")
        self.assertTrue(2 <= len(sent) <= 4, [c["t"] for c in sent])
        gaps = [b["t"] - a["t"] for a, b in zip(sent, sent[1:])]
        self.assertTrue(all(gap >= 600 for gap in gaps), gaps)


class PriceOutageTest(unittest.TestCase):
    def test_a_price_outage_until_expiry_retries_then_expires_and_says_so(self):
        world = World(cooldown=3600)
        world.at(5, world.null_feed)
        log = ListLog()
        drive(make_bot(world, log=log, retry_interval=30), world, 900)
        self.assertGreaterEqual(len(world.methods("execute_decision")), 5)
        self.assertEqual(len(world.methods("expire_decision")), 1)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"]), ("CycleFailed", "EXPIRED"))
        self.assertGreaterEqual(cycle["price_retries"], 5)
        self.assertEqual(cycle["failed_calls"], 0)

    def test_a_failed_call_is_counted_on_the_cycle(self):
        world = World(cooldown=3600)
        world.execute_script = ["PRICE_UNAVAILABLE"] * 50
        log = ListLog()
        bot = make_bot(world, log=log, retry_interval=30, max_call_failures=50)
        drive(bot, world, 20)  # one execute, rejected PRICE_UNAVAILABLE on chain
        world.force_panic["execute_decision"] = "NOT_KEEPER"  # then every execute fails by itself
        drive(bot, world, 800)
        (cycle,) = log.of("cycle")
        self.assertGreater(cycle["failed_calls"], 0)


class EventParsingTest(unittest.TestCase):
    GOOD = ('EVENT_JSON:{"standard":"foundling","version":"1.0.0","event":"hold",'
            '"data":[{"nonce":4,"code":"NO_DECISION"}]}')

    def test_malformed_events_are_skipped_and_do_not_hide_a_good_one(self):
        logs = ["EVENT_JSON:null", "EVENT_JSON:[1]", "EVENT_JSON:7", 'EVENT_JSON:"text"',
                'EVENT_JSON:{"standard":"foundling","event":"hold","data":["x"]}',
                'EVENT_JSON:{"standard":"foundling","event":"hold","data":{"a":1}}',
                'EVENT_JSON:{"standard":"foundling","event":"hold","data":[]}',
                'EVENT_JSON:{"standard":"foundling","event":["hold"],"data":[{"nonce":4}]}',
                "EVENT_JSON:{broken", self.GOOD]
        outcome = summarize(logs, 4)
        self.assertEqual((outcome["result"], outcome["code"]), ("Hold", "NO_DECISION"))

    def test_the_bot_asks_for_the_vaults_own_logs_only(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        drive(make_bot(world), world, 60)
        self.assertEqual(set(world.tx_log_executors), {VAULT})


class StaleHeightTest(unittest.TestCase):
    def test_a_bad_high_block_read_does_not_stop_the_bot_for_good(self):
        world = World(cooldown=3600, stuck_after=120)
        world.advance_mode = "noop"
        world.set_stage("Swapping", nonce=3, attempt=0, entered_at=int(world.now))
        log = ListLog()
        bot = make_bot(world, log=log)
        world.stale_blocks = [(world.height + 10_000_000, int(world.now))]  # one wild reading
        bot.tick()
        self.assertEqual(world.methods("advance"), [], "nothing to do yet, so the wild read cost nothing")
        for _ in range(60):  # 300 s: the swap becomes stuck at 120 s, long after the bad reading
            world.sleep(bot.config.poll_interval)
            bot.tick()
        self.assertGreaterEqual(len(world.methods("advance")), 1, "the bot acted again after it recovered")
        errors = log.of("error")
        self.assertTrue(errors and errors[0]["reason"] == "stale_block", "the stall was logged")


class FailureBackoffTest(unittest.TestCase):
    def failing_world(self):
        world = World(cooldown=60)
        world.force_panic["trigger_cycle"] = "SOME_NEW_REASON"
        return world

    def test_repeated_failures_back_off_exponentially_up_to_a_cap(self):
        world = self.failing_world()
        bot = make_bot(world, retry_interval=30, max_call_failures=50)
        drive(bot, world, 3000)
        times = [c["t"] for c in world.methods("trigger_cycle")]
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertGreaterEqual(gaps[1], 2 * gaps[0] - 6)
        self.assertGreaterEqual(gaps[2], 2 * gaps[1] - 6)
        self.assertTrue(all(g <= 600 + 6 for g in gaps), gaps)

    def test_it_gives_up_instead_of_burning_gas_for_ever(self):
        world = self.failing_world()
        bot = make_bot(world, retry_interval=30, max_call_failures=5)
        with self.assertRaises(GiveUp):
            for _ in range(10_000):
                bot.tick()
                world.sleep(bot.config.poll_interval)
        self.assertEqual(len(world.methods("trigger_cycle")), 5)

    def test_a_rotated_keeper_is_noticed_after_a_few_failures(self):
        world = self.failing_world()
        bot = make_bot(world, retry_interval=30)
        drive(bot, world, 40)
        world.keeper = "someone.else.test"
        with self.assertRaises(ConfigError):
            for _ in range(10_000):
                bot.tick()
                world.sleep(bot.config.poll_interval)

    def test_the_backoff_survives_a_restart(self):
        world = self.failing_world()
        store = MemoryStore()
        drive(make_bot(world, store=store, retry_interval=300), world, 6)
        self.assertEqual(len(world.methods("trigger_cycle")), 1)
        restarted = make_bot(world, store=store, retry_interval=300)
        drive(restarted, world, 100)
        self.assertEqual(len(world.methods("trigger_cycle")), 1, "the delay was not forgotten")

    def test_the_delay_is_counted_from_the_end_of_a_slow_call(self):
        world = self.failing_world()
        world.call_duration = 100
        drive(make_bot(world, retry_interval=30), world, 400)
        calls = world.methods("trigger_cycle")
        self.assertGreaterEqual(calls[1]["t"] - calls[0]["t"], 100 + 30)

    def test_a_success_clears_the_failure_count(self):
        world = self.failing_world()
        bot = make_bot(world, retry_interval=30, max_call_failures=3)
        drive(bot, world, 70)  # two failures, at about 0 and 30 s
        del world.force_panic["trigger_cycle"]
        drive(bot, world, 80)  # the retry at about 90 s succeeds and the cycle runs
        triggers = world.methods("trigger_cycle")
        self.assertEqual(len(triggers), 3)
        self.assertTrue(triggers[-1]["ok"])
        world.force_panic["trigger_cycle"] = "AGAIN"
        # After the cooldown: two more failures. GiveUp would fire on the first of them if the
        # two earlier failures still counted, since the limit is 3.
        drive(bot, world, 70)
        self.assertEqual(len([c for c in world.methods("trigger_cycle") if not c["ok"]]), 4)


class BlockingCallTest(unittest.TestCase):
    def test_a_trigger_that_returns_only_after_the_run_finished_is_still_tracked(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        world.call_duration = 40  # near-cli waits through the whole yield
        log = ListLog()
        drive(make_bot(world, log=log), world, 120)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"]), ("Hold", "NO_DECISION"))
        self.assertEqual(cycle["txs"][0]["hash"], "TX1")
        self.assertGreaterEqual(cycle["duration_s"], 40)

    def test_last_nonce_before_a_trigger_is_read_at_the_pinned_height(self):
        world = World()
        bot = make_bot(world)
        world.view_log.clear()
        height = world.height
        bot.tick()
        first = next(entry for entry in world.view_log if entry[1] == "last_nonce")
        self.assertEqual(first[2], height)


class ConfigTest(unittest.TestCase):
    def test_refuses_to_run_as_the_wrong_keeper(self):
        world = World()
        world.keeper = "someone.else.test"
        bot = Bot(Config(vault=VAULT, keeper_account=KEEPER), rpc=world, near=world.near,
                  sleep=world.sleep, clock=world.clock, log=ListLog(), store=MemoryStore())
        with self.assertRaises(ConfigError):
            bot.preflight()

    def test_gas_below_the_contract_minimum_is_refused(self):
        for key, floor in (("gas_trigger", "trigger_cycle"), ("gas_execute", "execute_decision"),
                           ("gas_advance", "advance")):
            with self.subTest(key), self.assertRaises(ConfigError):
                Config(vault=VAULT, keeper_account=KEEPER, **{key: GAS_FLOORS[floor] - 1})

    def test_only_testnet_is_allowed_without_the_flag(self):
        for name in ("mainnet", "Mainnet", "MAINNET", "localnet", ""):
            with self.subTest(name), self.assertRaises(ConfigError):
                Config(vault=VAULT, keeper_account=KEEPER, network=name)

    def test_mainnet_needs_an_explicit_flag(self):
        with self.assertRaises(ConfigError):
            Config(vault=VAULT, keeper_account=KEEPER, network="mainnet")
        Config(vault=VAULT, keeper_account=KEEPER, network="mainnet", allow_mainnet=True)

    def test_gas_floors_match_the_contract_source(self):
        def rust(path, name):
            text = (ROOT / "contracts/vault/src" / path).read_text()
            return int(re.search(rf"const {name}: Gas = Gas::from_tgas\((\d+)\)", text).group(1))

        expected = {
            "trigger_cycle": rust("cycle.rs", "MIN_TRIGGER_GAS"),
            "execute_decision": rust("swap.rs", "MIN_EXECUTE_GAS"),
            "advance": rust("recovery.rs", "MIN_ADVANCE_GAS"),
        }
        self.assertEqual(GAS_FLOORS, expected)
        self.assertEqual(WORLD_FLOORS, expected)


def fail_the_nonce_read_after_a_trigger(world):
    """The first `last_nonce` read of a trigger is the `before`; the next one, which waits for the nonce, fails once."""
    reads = []
    real = world.view

    def view(account, method, args=None, block_id=None):
        if method == "last_nonce":
            reads.append(1)
            if len(reads) == 2:
                raise RpcError("the node did not answer")
        return real(account, method, args, block_id)

    world.view = view


class TriggerSentTest(unittest.TestCase):
    def test_an_rpc_outage_right_after_the_trigger_keeps_the_cycle_the_bots(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        fail_the_nonce_read_after_a_trigger(world)
        log = ListLog()
        drive(make_bot(world, log=log), world, 90)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"]), ("Hold", "NO_DECISION"))
        self.assertEqual(cycle["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])
        self.assertFalse(cycle["resumed"])
        self.assertEqual(len(world.methods("trigger_cycle")), 1)

    def test_a_cycle_that_ended_during_the_outage_is_closed_from_the_saved_trigger(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        fail_the_nonce_read_after_a_trigger(world)
        store, log = MemoryStore(), ListLog()
        bot = make_bot(world, store=store, log=log)
        self.assertEqual(bot.tick(), "error")
        self.assertEqual(store.data["pending"]["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])
        world.sleep(30)  # the whole cycle ends while the bot cannot read
        self.assertEqual(world.kind(), "Idle")
        drive(bot, world, 20)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"], cycle["resumed"]), ("Hold", "NO_DECISION", False))
        self.assertEqual(cycle["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])
        self.assertIsNone(store.data["pending"])
        self.assertEqual(len(world.methods("trigger_cycle")), 1, "no second trigger")

    def test_the_saved_trigger_survives_a_restart(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        fail_the_nonce_read_after_a_trigger(world)
        store, log = MemoryStore(), ListLog()
        self.assertEqual(make_bot(world, store=store, log=log).tick(), "error")
        drive(make_bot(world, store=store, log=log), world, 60)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["resumed"]), ("Hold", False))
        self.assertEqual(cycle["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])

    def test_a_trigger_that_never_landed_is_dropped_after_the_grace(self):
        world = World()
        pending = {"before": 0, "started": world.now - 100, "at": int(world.now) - 100,
                   "until": world.now - 10, "txs": [{"method": "trigger_cycle", "hash": "TX1"}]}
        store = MemoryStore({"vault": VAULT, "last_trigger": 0, "cycle": None, "pending": pending})
        log = ListLog()
        bot = make_bot(world, store=store, log=log)
        bot.tick()
        self.assertIsNone(bot.state["pending"])
        self.assertEqual(log.of("cycle"), [])

    def test_a_trigger_just_sent_is_waited_for_before_it_is_dropped(self):
        world = World()
        pending = {"before": 0, "started": world.now, "at": int(world.now),
                   "until": world.now + 90, "txs": [{"method": "trigger_cycle", "hash": "TX1"}]}
        store = MemoryStore({"vault": VAULT, "last_trigger": 0, "cycle": None, "pending": pending})
        bot = make_bot(world, store=store)
        self.assertEqual(bot.tick(), "wait")
        self.assertIsNotNone(bot.state["pending"])
        self.assertEqual(world.methods("trigger_cycle"), [], "it does not trigger again meanwhile")


def without_hash(world):
    """The trigger lands, but near-cli reports it with no transaction hash."""
    real = world.near.call

    def call(contract, method, args, gas):
        result = real(contract, method, args, gas)
        return CallResult(result.ok, None, result.error) if method == "trigger_cycle" else result

    world.near.call = call


class PendingAttributionTest(unittest.TestCase):
    def test_a_trigger_with_no_hash_is_not_carried_over_and_stays_the_bots_own_cycle(self):
        world = World(cooldown=3600)
        without_hash(world)
        store, log = MemoryStore(), ListLog()
        bot = make_bot(world, store=store, log=log)
        bot.tick()
        self.assertIsNone(store.data["pending"])
        self.assertEqual(store.data["cycle"]["txs"], [])
        # Lead's decision (#21, after the #53 review): the bot's own trigger stays judged even without a
        # hash, so it is not marked as taken over; `hashless` says why its outcome may be Unknown.
        self.assertFalse(store.data["cycle"]["resumed"])
        self.assertTrue(store.data["cycle"]["hashless"])

    def test_a_cycle_of_someone_else_is_not_taken_for_the_bots_after_a_trigger_with_no_hash(self):
        world = World(cooldown=10)
        real = world.near.call
        world.near.call = lambda *a: CallResult(False, None, "timeout: no answer")  # never reached the chain
        fail_the_nonce_read_after_a_trigger(world)
        store, log = MemoryStore(), ListLog()
        bot = make_bot(world, store=store, log=log)
        self.assertEqual(bot.tick(), "error")
        self.assertIsNone(store.data.get("pending"), "no hash, nothing to attribute")
        world.near.call = real
        world.apply("trigger_cycle", {}, 300)  # someone else triggers
        world.trigger_result = "hold"
        drive(bot, world, 40)
        cycle = log.of("cycle")[0]
        self.assertEqual((cycle["nonce"], cycle["resumed"], cycle["txs"]), (1, True, []))

    def test_a_cycle_that_ended_unseen_is_closed_even_when_another_one_is_live(self):
        world = World(cooldown=10)
        world.trigger_result = "hold"
        fail_the_nonce_read_after_a_trigger(world)
        store, log = MemoryStore(), ListLog()
        bot = make_bot(world, store=store, log=log)
        self.assertEqual(bot.tick(), "error")
        world.sleep(30)  # the bot's cycle 1 ends
        world.trigger_result = "ready"
        world.apply("trigger_cycle", {}, 300)  # someone else starts cycle 2
        bot.tick()
        first = log.of("cycle")[0]
        self.assertEqual((first["nonce"], first["result"], first["final_stage"], first["resumed"]),
                         (1, "Hold", "Unobserved", False))
        self.assertEqual(first["txs"], [{"method": "trigger_cycle", "hash": "TX1"}])
        self.assertEqual((store.data["cycle"]["nonce"], store.data["cycle"]["resumed"]), (2, True))

    def test_a_trigger_the_node_shows_late_is_still_the_bots_after_the_nonce_wait_gave_up(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        lagging = [True]
        real = world.view

        def view(account, method, args=None, block_id=None):
            if method == "last_nonce" and lagging[0]:
                return 0
            return real(account, method, args, block_id)

        world.view = view
        store, log = MemoryStore(), ListLog()
        bot = make_bot(world, store=store, log=log, nonce_wait=10)
        self.assertEqual(bot.tick(), "trigger_failed")
        self.assertEqual(len(store.data["pending"]["txs"]), 1, "kept: the hash is known")
        self.assertGreater(store.data["failures"]["streak"], 0)
        lagging[0] = False
        drive(bot, world, 20)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["nonce"], cycle["result"], cycle["resumed"]), (1, "Hold", False))
        self.assertEqual(len(world.methods("trigger_cycle")), 1, "no second trigger")
        self.assertEqual(store.data["failures"]["streak"], 0, "the trigger landed, so its failed wait is forgiven")



class HashlessTriggerTest(unittest.TestCase):
    """Lead's decision (#21): a trigger the bot sent stays its own cycle and is judged, hash or not."""

    def test_a_hashless_cycle_is_logged_as_the_bots_and_says_its_hash_is_missing(self):
        world = World(cooldown=3600)
        without_hash(world)
        world.trigger_result = "hold"
        log = ListLog()
        bot = make_bot(world, store=MemoryStore(), log=log)
        drive(bot, world, 120)
        cycles = log.of("cycle")
        self.assertEqual(len(cycles), 1)
        self.assertFalse(cycles[0]["resumed"])
        self.assertTrue(cycles[0]["trigger_hash_missing"])
        self.assertEqual(cycles[0]["txs"], [])

    def test_a_cycle_with_its_hash_says_nothing_is_missing(self):
        world = World(cooldown=3600)
        world.trigger_result = "hold"
        log = ListLog()
        bot = make_bot(world, store=MemoryStore(), log=log)
        drive(bot, world, 120)
        self.assertFalse(log.of("cycle")[0]["trigger_hash_missing"])

    def test_someone_elses_cycle_is_still_taken_over_and_not_marked_hashless(self):
        world = World(cooldown=3600)
        world.apply("trigger_cycle", {}, 300)  # someone else triggers before the bot runs
        world.trigger_result = "hold"
        log = ListLog()
        bot = make_bot(world, store=MemoryStore(), log=log)
        drive(bot, world, 120)
        first = log.of("cycle")[0]
        self.assertTrue(first["resumed"])
        self.assertFalse(first["trigger_hash_missing"])



class UnconfirmedTriggerTest(unittest.TestCase):
    """A trigger near-cli timed out on with no hash may never have landed: the cycle that follows is
    taken over, not claimed as the bot's own (#70 review)."""

    def test_a_timed_out_hashless_trigger_leaves_the_cycle_taken_over(self):
        world = World(cooldown=3600)
        real = world.near.call

        def call(contract, method, args, gas):
            if method == "trigger_cycle":
                world.apply("trigger_cycle", {}, 300)  # a trigger lands: the bot cannot tell whose
                return CallResult(False, None, "timeout: no answer")
            return real(contract, method, args, gas)

        world.near.call = call
        world.trigger_result = "hold"
        log = ListLog()
        bot = make_bot(world, store=MemoryStore(), log=log)
        drive(bot, world, 120)
        cycle = log.of("cycle")[0]
        self.assertTrue(cycle["resumed"])
        self.assertFalse(cycle["trigger_hash_missing"])


if __name__ == "__main__":
    unittest.main()
