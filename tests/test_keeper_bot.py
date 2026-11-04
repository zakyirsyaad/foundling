"""The keeper state machine against a model vault. No network, no real clock, no near-cli."""

import re
import unittest
from pathlib import Path

from tests.keeper_fakes import GAS_FLOORS as WORLD_FLOORS
from tests.keeper_fakes import KEEPER, NEAR_ID, USDC_ID, VAULT, ListLog, MemoryStore, World
from tools.keeper.bot import GAS_FLOORS, Bot, Config, ConfigError

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

    def test_holds_execute_while_a_price_feed_is_null(self):
        world = World()
        world.set_stage("DecisionReady", nonce=1, expires_at=int(world.now) + 600)
        world.null_feed(NEAR_ID)
        bot = make_bot(world)
        drive(bot, world, 60)
        self.assertEqual(world.methods("execute_decision"), [])
        world.feeds[NEAR_ID] = True
        drive(bot, world, 20)
        self.assertEqual(len(world.methods("execute_decision")), 1)

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
        world.set_stage("DecisionReady", nonce=4, expires_at=int(world.now) + 100)
        world.null_feed(NEAR_ID)
        bot = make_bot(world)
        drive(bot, world, 90)
        self.assertEqual(world.methods("expire_decision"), [])
        drive(bot, world, 30)
        self.assertEqual(len(world.methods("expire_decision")), 1)
        self.assertEqual(world.methods("execute_decision"), [])


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
    def test_a_price_outage_until_expiry_is_recorded_as_such(self):
        world = World(cooldown=3600)
        world.at(5, world.null_feed)
        log = ListLog()
        drive(make_bot(world, log=log), world, 900)
        self.assertEqual(world.methods("execute_decision"), [])
        self.assertEqual(len(world.methods("expire_decision")), 1)
        (cycle,) = log.of("cycle")
        self.assertEqual((cycle["result"], cycle["code"]), ("CycleFailed", "EXPIRED"))
        self.assertGreater(cycle["price_skips"], 0)


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


if __name__ == "__main__":
    unittest.main()
