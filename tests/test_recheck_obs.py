"""The obs recheck against recorded replies, with no network."""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("recheck_obs", ROOT / "tools" / "recheck_obs.py")
recheck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recheck)

TA = 1_793_544_160
TB = 1_793_544_101
USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
USDC_AMOUNT = 4_390_552_740_000
WNEAR_AMOUNT = 1_000_000 * 10**24
PA = 439_055_274


def pool_reply(usdc=USDC_AMOUNT):
    return {
        "pool_kind": "SIMPLE_POOL",
        "token_account_ids": [USDC, "wrap.near"],
        "amounts": [str(usdc), str(WNEAR_AMOUNT)],
    }


class FakeSources:
    """A chain with one block per second from `first`, and a list of Kraken rows."""

    def __init__(self, rows=(), first=TA - 100, count=200, down=False):
        self.first, self.count = first, count
        self.rows, self.down = list(rows), down
        self.calls = 0

    def tip(self):
        self.fail_if_down()
        return self.first + self.count - 1

    def block_seconds(self, height):
        self.fail_if_down()
        self.calls += 1
        return None if height == self.first + 5 else height

    def pool(self, height):
        self.fail_if_down()
        self.calls += 1
        return pool_reply()

    def trades(self, since, until):
        self.fail_if_down()
        return [row for row in self.rows if since <= float(row[2])]

    def fail_if_down(self):
        if self.down:
            raise recheck.SourceDown("no route")


def http_error(code):
    return recheck.urllib.error.HTTPError("https://example.test", code, "refused", None, None)


def row(price, volume, seconds):
    return [price, volume, seconds + 0.25, "b", "m", "", 1]


def proof(obs):
    return {"cycles": [{"decision": json.dumps({"nonce": 1, "obs": obs})}]}


def clean_obs(**changes):
    return {"pa": str(PA), "pb": "300000000", "ta": TA, "tb": TB, **changes}


ROWS = [row("3.00000000", "2.0", TB - 9), row("3.00000000", "1.0", TB)]


class PoolSpot(unittest.TestCase):
    def test_matches_the_strategy_rule(self):
        self.assertEqual(recheck.pool_spot(pool_reply()), PA)

    def test_refuses_another_pool(self):
        self.assertIsNone(recheck.pool_spot(pool_reply() | {"pool_kind": "STABLE_SWAP"}))

    def test_refuses_swapped_tokens(self):
        pool = pool_reply() | {"token_account_ids": ["wrap.near", USDC]}
        self.assertIsNone(recheck.pool_spot(pool))


class ParseDecimal(unittest.TestCase):
    def test_keeps_eight_decimals_and_drops_the_rest(self):
        self.assertEqual(recheck.parse_decimal("4.123456789"), 412_345_678)

    def test_pads_short_fractions(self):
        self.assertEqual(recheck.parse_decimal("4.5"), 450_000_000)

    def test_reads_a_whole_number(self):
        self.assertEqual(recheck.parse_decimal("4"), 400_000_000)


class Vwap(unittest.TestCase):
    def test_weights_by_volume(self):
        rows = [row("2.0", "1.0", TB), row("5.0", "2.0", TB)]
        self.assertEqual(recheck.vwap(rows), 400_000_000)


class Check(unittest.TestCase):
    def report(self, obs, sources):
        return recheck.check_proof(proof(obs), sources)

    def test_a_true_reading_passes_both_prices(self):
        report = self.report(clean_obs(), FakeSources(ROWS))
        self.assertEqual((report.passed, report.failed, report.skipped), (2, 0, 0))

    def test_a_false_pool_price_fails(self):
        report = self.report(clean_obs(pa=str(PA + 1)), FakeSources(ROWS))
        self.assertEqual((report.passed, report.failed), (1, 1))
        self.assertIn("FAIL nonce 1 pa", "\n".join(report.lines))

    def test_a_false_trade_price_fails(self):
        report = self.report(clean_obs(pb="300000001"), FakeSources(ROWS))
        self.assertEqual((report.passed, report.failed), (1, 1))
        self.assertIn("FAIL nonce 1 pb", "\n".join(report.lines))

    def test_the_last_block_inside_the_second_may_be_the_one_that_matches(self):
        sources = FakeSources(ROWS)
        sources.block_seconds = lambda height: height - height % 3
        sources.pool = lambda height: pool_reply(USDC_AMOUNT + (height % 3 != 2))
        report = self.report(clean_obs(ta=TA - TA % 3), sources)
        self.assertEqual(report.failed, 0)

    def test_only_trades_up_to_tb_count(self):
        late = row("9.00000000", "50.0", TB + 1)
        report = self.report(clean_obs(), FakeSources(ROWS + [late]))
        self.assertEqual(report.failed, 0)

    def test_the_window_is_the_last_twenty_trades(self):
        old = [row("9.00000000", "50.0", TB - 500)]
        recent = [row("3.00000000", "1.0", TB - 19 + index) for index in range(20)]
        report = self.report(clean_obs(), FakeSources(old + recent))
        self.assertEqual(report.failed, 0)

    def test_a_time_past_the_chain_fails(self):
        report = self.report(clean_obs(ta=TA + 100_000), FakeSources(ROWS))
        self.assertEqual(report.failed, 1)

    def test_a_second_with_no_block_fails(self):
        report = self.report(clean_obs(ta=FakeSources().first + 5), FakeSources(ROWS))
        self.assertEqual(report.failed, 1)

    def test_a_time_with_no_trade_fails(self):
        report = self.report(clean_obs(tb=TB - 3), FakeSources(ROWS))
        self.assertEqual(report.failed, 1)

    def test_an_unread_market_is_skipped(self):
        report = self.report({"pa": "0", "pb": "0", "ta": 0, "tb": 0}, FakeSources())
        self.assertEqual((report.passed, report.failed, report.skipped), (0, 0, 2))

    def test_a_source_that_is_down_is_a_skip_not_a_failure(self):
        report = self.report(clean_obs(), FakeSources(down=True))
        self.assertEqual((report.failed, report.skipped), (0, 2))
        self.assertTrue(report.source_down)

    def test_one_source_down_still_checks_the_other(self):
        sources = FakeSources(ROWS)

        def refuse(since, until):
            raise recheck.SourceDown("blocked")

        sources.trades = refuse
        report = self.report(clean_obs(), sources)
        self.assertEqual((report.passed, report.skipped), (1, 1))

    def test_a_proof_without_cycles_fails(self):
        report = recheck.check_proof({"cycles": []}, FakeSources())
        self.assertEqual(report.failed, 1)

    def test_the_search_stays_small(self):
        sources = FakeSources(ROWS, first=TA - 4_000_000, count=8_000_000)
        self.report(clean_obs(), sources)
        self.assertLess(sources.calls, recheck.MAX_BLOCK_READS)


class Reading(unittest.TestCase):
    def read_with(self, failures):
        attempts = []

        def fail(request, timeout):
            attempts.append(request)
            raise failures

        with mock.patch.object(recheck.urllib.request, "urlopen", fail), mock.patch.object(
            recheck.time, "sleep"
        ):
            with self.assertRaises(recheck.SourceDown):
                recheck.PublicSources.read(recheck.urllib.request.Request("https://example.test"))
        return len(attempts)

    def test_a_timeout_is_tried_again(self):
        self.assertEqual(self.read_with(TimeoutError("slow")), recheck.RETRIES)

    def test_a_wrapped_timeout_is_tried_again(self):
        error = recheck.urllib.error.URLError(TimeoutError("slow"))
        self.assertEqual(self.read_with(error), recheck.RETRIES)

    def test_a_bad_certificate_is_not_tried_again(self):
        error = recheck.urllib.error.URLError("hostname mismatch")
        self.assertEqual(self.read_with(error), 1)

    def test_a_rate_limit_is_tried_again(self):
        self.assertEqual(self.read_with(http_error(429)), recheck.RETRIES)

    def test_a_block_the_archive_refused_is_tried_again(self):
        self.assertEqual(self.read_with(http_error(422)), recheck.RETRIES)

    def test_a_forbidden_request_is_not_tried_again(self):
        self.assertEqual(self.read_with(http_error(403)), 1)

    def test_the_wait_doubles_between_tries(self):
        def fail(request, timeout):
            raise http_error(429)

        with mock.patch.object(recheck.urllib.request, "urlopen", fail), mock.patch.object(
            recheck.time, "sleep"
        ) as sleep:
            with self.assertRaises(recheck.SourceDown):
                recheck.PublicSources.read(recheck.urllib.request.Request("https://example.test"))
        waits = [call.args[0] for call in sleep.call_args_list]
        self.assertEqual(waits, [2, 4, 8, 16])


class FakeKraken:
    """Kraken's trade history as it answers: `since` includes the trade at that instant, and
    `last` is the time of the page's last trade, so every page opens with the row before it."""

    def __init__(self, trades):
        self.trades = trades
        self.requests = 0

    def read(self, request):
        self.requests += 1
        since = int(request.full_url.split("since=")[1].split("&")[0])
        page = [t for t in self.trades if t["nanos"] >= since][: recheck.TRADE_PAGE]
        rows = [[t["price"], t["volume"], t["nanos"] / recheck.NANOS_PER_SECOND, "b", "l", "", t["id"]] for t in page]
        return {"error": [], "result": {recheck.TRADE_PAIR: rows, "last": str(page[-1]["nanos"])}}


def history(count, first_second, same_instant_at=()):
    """One trade a second with rising ids; the ids in `same_instant_at` share the time of the one before."""
    trades, nanos = [], first_second * recheck.NANOS_PER_SECOND
    for number in range(count):
        if number and number not in same_instant_at:
            nanos += recheck.NANOS_PER_SECOND
        trades.append({"id": number, "nanos": nanos, "price": f"{3 + number % 7 / 100:.5f}", "volume": f"{1 + number % 5}.00000000"})
    return trades


class TradePages(unittest.TestCase):
    def read_all(self, trades, until):
        kraken = FakeKraken(trades)
        sources = recheck.PublicSources()
        sources.read = kraken.read
        return sources.trades(trades[0]["nanos"] // recheck.NANOS_PER_SECOND, until), kraken

    def test_a_trade_on_a_page_edge_is_read_once(self):
        trades = history(2 * recheck.TRADE_PAGE + 500, TB - 2600)
        rows, _ = self.read_all(trades, TB)
        self.assertEqual([row[6] for row in rows], [t["id"] for t in trades])

    def test_trades_sharing_the_instant_of_a_page_edge_are_read_once(self):
        edge = recheck.TRADE_PAGE
        trades = history(2 * recheck.TRADE_PAGE, TB - 2600, same_instant_at=(edge - 1, edge))
        rows, _ = self.read_all(trades, TB)
        self.assertEqual([row[6] for row in rows], [t["id"] for t in trades])

    def test_a_window_across_a_page_edge_gives_the_price_of_twenty_distinct_trades(self):
        trades = history(recheck.TRADE_PAGE + 10, TB - recheck.TRADE_PAGE - 9)
        last = trades[-1]["nanos"] // recheck.NANOS_PER_SECOND
        window = [[t["price"], t["volume"]] for t in trades[-recheck.TRADE_WINDOW :]]
        kraken = FakeKraken(trades)
        sources = recheck.PublicSources()
        sources.read = kraken.read
        with mock.patch.object(recheck, "TRADE_LOOKBACK_SECONDS", recheck.TRADE_PAGE + 9):
            self.assertEqual(recheck.trade_prices_in_second(sources, last), [recheck.vwap(window)])

    def test_a_page_with_nothing_new_ends_the_read(self):
        trades = history(recheck.TRADE_PAGE, TB - 5000, same_instant_at=range(1, recheck.TRADE_PAGE))
        rows, kraken = self.read_all(trades, TB)
        self.assertEqual(len(rows), recheck.TRADE_PAGE)
        self.assertEqual(kraken.requests, 2)


class BlockTimes(unittest.TestCase):
    def test_a_block_is_read_once(self):
        sources = recheck.PublicSources()
        reply = {"result": {"header": {"timestamp": TA * recheck.NANOS_PER_SECOND}}}
        sources.rpc = mock.Mock(return_value=reply)
        self.assertEqual(sources.block_seconds(7), TA)
        self.assertEqual(sources.block_seconds(7), TA)
        sources.rpc.assert_called_once()

    def test_a_missing_height_is_read_once(self):
        sources = recheck.PublicSources()
        sources.rpc = mock.Mock(return_value={"error": {"name": "UNKNOWN_BLOCK"}})
        self.assertIsNone(sources.block_seconds(7))
        self.assertIsNone(sources.block_seconds(7))
        sources.rpc.assert_called_once()


class Summary(unittest.TestCase):
    def test_the_last_line_counts_everything(self):
        report = recheck.Report(passed=2, failed=1, skipped=3)
        self.assertEqual(report.summary(), "SUMMARY pass=2 skip=3 fail=1")

    def test_exit_codes(self):
        self.assertEqual(recheck.Report().exit_code(), 0)
        self.assertEqual(recheck.Report(failed=1).exit_code(), 1)
        self.assertEqual(recheck.Report(source_down=True).exit_code(), 2)
        self.assertEqual(recheck.Report(failed=1, source_down=True).exit_code(), 1)


if __name__ == "__main__":
    unittest.main()
