"""The soak log, the state file and the summary that decides whether a soak passed."""

import json
import tempfile
import unittest
from pathlib import Path

from tools.keeper.logstore import FileStore, JsonlLog, StateError
from tools.keeper.soak import render, summarize_log


def cycle(nonce, result="Hold", code="NO_DECISION", stuck=False, final_stage="Idle", retries=0,
          failed=0):
    return {"kind": "cycle", "nonce": nonce, "result": result, "code": code, "stuck": stuck,
            "final_stage": final_stage, "price_retries": retries, "failed_calls": failed, "txs": [],
            "duration_s": 12.0}


def lines(*records):
    return [json.dumps(r) for r in records]


class SummaryTest(unittest.TestCase):
    def test_soak_summary_flags_unexpected_codes(self):
        records = [
            cycle(1),
            cycle(2, "Rejected", "OVER_CAP"),
            cycle(3, "CycleFailed", "COMMITMENT_MISMATCH"),
            cycle(4, "Executed", None, stuck=True),
            cycle(5, "Unknown", None),
            cycle(6, "SwapReverted", None),
            cycle(7, "CycleFailed", "EXPIRED"),
        ]
        summary = summarize_log(lines(*records))
        self.assertFalse(summary.passed)
        self.assertEqual([u["nonce"] for u in summary.unexpected], [2, 3, 4, 5, 6, 7])
        reasons = {u["nonce"]: u["reason"] for u in summary.unexpected}
        self.assertEqual(reasons[2], "Rejected(OVER_CAP)")
        self.assertEqual(reasons[4], "Stuck")

    def test_the_expected_set_passes(self):
        records = [
            cycle(1),
            cycle(2, "Rejected", "PRICE_WIDE"),
            cycle(3, "Rejected", "PRICE_UNAVAILABLE"),
            cycle(4, "CycleFailed", "NULL_RESULT"),
            cycle(5, "Executed", None, retries=2),
        ]
        summary = summarize_log(lines(*records))
        self.assertTrue(summary.passed, summary.unexpected)
        self.assertEqual(summary.cycles, 5)
        self.assertEqual(summary.price_retries, 2)

    def test_expiry_after_repeated_price_unavailable_is_expected(self):
        summary = summarize_log(lines(cycle(1, "CycleFailed", "EXPIRED", retries=4)))
        self.assertTrue(summary.passed, summary.unexpected)

    def test_expiry_with_no_price_rejection_is_still_unexpected(self):
        summary = summarize_log(lines(cycle(1, "CycleFailed", "EXPIRED")))
        self.assertEqual([u["reason"] for u in summary.unexpected], ["CycleFailed(EXPIRED)"])

    def test_expiry_after_a_price_rejection_and_failed_calls_is_not_hidden(self):
        # One PRICE_UNAVAILABLE, then every execute failed on its own: that is not a price outage.
        summary = summarize_log(lines(cycle(1, "CycleFailed", "EXPIRED", retries=1, failed=20)))
        self.assertFalse(summary.passed)
        self.assertEqual([u["nonce"] for u in summary.unexpected], [1])

    def test_error_lines_are_counted_and_shown_but_do_not_fail_the_soak(self):
        summary = summarize_log(lines(cycle(1), {"kind": "error", "reason": "RpcError"}))
        self.assertEqual(summary.errors, 1)
        self.assertTrue(summary.passed)
        self.assertIn("RPC errors: 1", render(summary))

    def test_a_soak_with_no_cycles_fails_unless_allowed(self):
        self.assertFalse(summarize_log([]).passed)
        self.assertTrue(summarize_log([], min_cycles=0).passed)

    def test_a_malformed_line_fails_the_soak(self):
        summary = summarize_log([*lines(cycle(1)), '{"kind": "cycle", "nonce"'])
        self.assertFalse(summary.passed)
        self.assertEqual(summary.malformed, 1)

    def test_other_line_kinds_are_counted_apart_from_cycles(self):
        records = [cycle(1), {"kind": "skip", "reason": "price_null"},
                   {"kind": "call_failed", "method": "trigger_cycle", "error": "COOLDOWN"}]
        summary = summarize_log(lines(*records))
        self.assertEqual((summary.cycles, summary.skips, summary.call_failures), (1, 1, 1))
        self.assertTrue(summary.passed)

    def test_failed_calls_raise_a_warning_even_when_the_soak_passes(self):
        records = [cycle(1), {"kind": "call_failed", "method": "execute_decision", "error": "x"}]
        summary = summarize_log(lines(*records))
        self.assertTrue(summary.passed)
        self.assertIn("Warning: failed calls: 1", render(summary))
        self.assertNotIn("Warning", render(summarize_log(lines(cycle(1)))))

    def test_render_names_the_verdict_and_each_unexpected_cycle(self):
        text = render(summarize_log(lines(cycle(1), cycle(2, "Rejected", "OVER_CAP"))))
        self.assertIn("Soak: FAIL", text)
        self.assertIn("nonce 2", text)
        self.assertIn("Rejected(OVER_CAP)", text)
        self.assertIn("Soak: PASS", render(summarize_log(lines(cycle(1)))))


def untriggered(nonce, **extra):
    return {**cycle(nonce, "Unknown", None), "resumed": True, "txs": [], **extra}


class UntriggeredCyclesTest(unittest.TestCase):
    def test_a_cycle_the_bot_did_not_trigger_does_not_fail_the_soak(self):
        summary = summarize_log(lines(cycle(1), untriggered(2)))
        self.assertTrue(summary.passed, summary.unexpected)
        self.assertEqual((summary.cycles, summary.untriggered), (1, 1))

    def test_it_is_counted_apart_and_shown(self):
        text = render(summarize_log(lines(cycle(1), untriggered(2), untriggered(3))))
        self.assertIn("did not trigger (not counted, not judged): 2", text)
        self.assertNotIn("did not trigger", render(summarize_log(lines(cycle(1)))))

    def test_it_does_not_count_toward_the_minimum_cycles(self):
        summary = summarize_log(lines(untriggered(1)), min_cycles=1)
        self.assertFalse(summary.passed)
        self.assertEqual(summary.cycles, 0)

    def test_one_that_went_stuck_still_fails(self):
        for record in (untriggered(1, stuck=True), untriggered(1, final_stage="Stuck")):
            with self.subTest(record):
                summary = summarize_log(lines(cycle(2), record))
                self.assertEqual([u["reason"] for u in summary.unexpected], ["Stuck"])
                self.assertFalse(summary.passed)

    def test_unknown_with_a_transaction_of_the_bot_still_fails(self):
        record = {**cycle(1, "Unknown", None), "resumed": False, "txs": [{"method": "trigger_cycle", "hash": "H"}]}
        self.assertEqual([u["reason"] for u in summarize_log(lines(record)).unexpected], ["Unknown"])

    def test_one_where_a_call_of_the_bot_failed_is_judged(self):
        summary = summarize_log(lines(cycle(1), untriggered(2, failed_calls=1)))
        self.assertEqual([u["reason"] for u in summary.unexpected], ["Unknown"])
        self.assertEqual(summary.untriggered, 0)

    def test_a_taken_over_cycle_with_a_known_result_is_judged_as_usual(self):
        record = {**cycle(1, "Rejected", "OVER_CAP"), "resumed": True, "txs": [{"method": "advance", "hash": "H"}]}
        summary = summarize_log(lines(record))
        self.assertEqual([u["reason"] for u in summary.unexpected], ["Rejected(OVER_CAP)"])


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name)

    def test_jsonl_log_appends_one_json_object_per_line(self):
        log = JsonlLog(self.path / "soak.jsonl")
        log.write({"kind": "cycle", "nonce": 1})
        JsonlLog(self.path / "soak.jsonl").write({"kind": "cycle", "nonce": 2})
        rows = [json.loads(line) for line in (self.path / "soak.jsonl").read_text().splitlines()]
        self.assertEqual([r["nonce"] for r in rows], [1, 2])

    def test_file_store_round_trips_and_starts_empty(self):
        store = FileStore(self.path / "state.json")
        self.assertEqual(store.load(), {})
        store.save({"last_trigger": 5, "cycle": None})
        self.assertEqual(FileStore(self.path / "state.json").load(), {"last_trigger": 5, "cycle": None})
        self.assertEqual([p.name for p in self.path.iterdir()], ["state.json"], "no temp file left")

    def test_a_corrupt_state_file_is_a_named_error_not_a_traceback(self):
        (self.path / "state.json").write_text("{not json")
        with self.assertRaises(StateError):
            FileStore(self.path / "state.json").load()


if __name__ == "__main__":
    unittest.main()
