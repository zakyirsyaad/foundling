#!/usr/bin/env python3
"""Checks the prices a run reported against the public sources, at the times it reported.

Usage:
  python3 tools/recheck_obs.py <proof.json>

Replay shows the rule was applied to `obs`, and the quote shows the run reported it. This is
what shows `obs` was true. `pa` comes back exactly from pool 4512 at a block inside second
`ta`, read from an archive node. `pb` comes back exactly from the last twenty Kraken trades
ending inside second `tb`. The rules are the ones in `strategy/src/sources.rs`, and both
sources are mainnet whichever chain the vault runs on.

Needs no keys. Exit code 0 means nothing failed, 1 means a price did not come back, and 2
means a source could not be read, so its checks are SKIP and nothing is proven either way.
"""

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

ARCHIVE_RPC = "https://archival-rpc.mainnet.fastnear.com"
GENESIS_HEIGHT = 9_820_210
TRADES_URL = "https://api.kraken.com/0/public/Trades?pair=NEARUSD&since={since}&count=1000"
TRADE_PAIR = "NEARUSD"
TRADE_WINDOW = 20
TRADE_PAGE = 1000
TRADE_LOOKBACK_SECONDS = 24 * 60 * 60
REF = "v2.ref-finance.near"
USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
WNEAR = "wrap.near"
POOL_KIND = "SIMPLE_POOL"
POOL_ARGS = base64.b64encode(b'{"pool_id":4512}').decode()
PRICE_DECIMALS = 8
PRICE_ONE = 100_000_000
WNEAR_UNITS_PER_USDC_UNIT = 10**18
NANOS_PER_SECOND = 10**9
MAX_BLOCK_READS = 96
REQUEST_TIMEOUT_SECONDS = 30
RETRIES = 4
RETRY_DELAY_SECONDS = 2
UNKNOWN_BLOCK_NAMES = ("UNKNOWN_BLOCK", "GARBAGE_COLLECTED_BLOCK")


class SourceDown(Exception):
    """A public source could not be read, which proves nothing about the price."""


@dataclass
class Report:
    lines: list = field(default_factory=list)
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    source_down: bool = False

    def check(self, name, holds, detail):
        if holds:
            self.passed += 1
            self.lines.append(f"PASS {name}")
        else:
            self.failed += 1
            self.lines.append(f"FAIL {name}: {detail}")

    def skip(self, name, reason):
        self.skipped += 1
        self.lines.append(f"SKIP {name}: {reason}")

    def summary(self):
        return f"SUMMARY pass={self.passed} skip={self.skipped} fail={self.failed}"

    def exit_code(self):
        if self.failed:
            return 1
        return 2 if self.source_down else 0


def parse_decimal(text):
    """Eight decimals, digits past them dropped, as `parse_decimal` in the strategy."""
    whole, _, fraction = text.partition(".")
    return int(whole) * PRICE_ONE + int(fraction[:PRICE_DECIMALS].ljust(PRICE_DECIMALS, "0"))


def pool_spot(pool):
    if pool["pool_kind"] != POOL_KIND or pool["token_account_ids"] != [USDC, WNEAR]:
        return None
    usdc, wnear = (int(amount) for amount in pool["amounts"])
    return usdc * PRICE_ONE // (wnear // WNEAR_UNITS_PER_USDC_UNIT)


def vwap(rows):
    value = sum(parse_decimal(row[0]) * parse_decimal(row[1]) for row in rows)
    volume = sum(parse_decimal(row[1]) for row in rows)
    return value // volume


def trade_seconds(row):
    return int(float(row[2]))


def timed_out(error):
    """Worth another try, unlike a certificate that names the wrong host."""
    return isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError)


class PublicSources:
    @staticmethod
    def read(request):
        for attempt in range(RETRIES):
            try:
                with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as reply:
                    return json.load(reply)
            except urllib.error.HTTPError as error:
                if error.code != 429 or attempt == RETRIES - 1:
                    raise SourceDown(f"{request.full_url}: HTTP {error.code}") from error
            except (urllib.error.URLError, TimeoutError, ValueError) as error:
                if not timed_out(error) or attempt == RETRIES - 1:
                    raise SourceDown(f"{request.full_url}: {error}") from error
            time.sleep(RETRY_DELAY_SECONDS * (attempt + 1))
        raise SourceDown(request.full_url)

    def rpc(self, method, params):
        body = {"jsonrpc": "2.0", "id": "foundling", "method": method, "params": params}
        headers = {"content-type": "application/json"}
        request = urllib.request.Request(ARCHIVE_RPC, json.dumps(body).encode(), headers)
        return self.read(request)

    def tip(self):
        reply = self.rpc("block", {"finality": "final"})
        if "result" not in reply:
            raise SourceDown(f"no tip: {reply.get('error')}")
        return reply["result"]["header"]["height"]

    def block_seconds(self, height):
        """`None` for a height with no block, since the chain skips some."""
        reply = self.rpc("block", {"block_id": height})
        if "result" in reply:
            return reply["result"]["header"]["timestamp"] // NANOS_PER_SECOND
        error = json.dumps(reply.get("error"))
        if any(name in error for name in UNKNOWN_BLOCK_NAMES):
            return None
        raise SourceDown(f"block {height}: {error[:200]}")

    def pool(self, height):
        params = {
            "request_type": "call_function",
            "block_id": height,
            "account_id": REF,
            "method_name": "get_pool",
            "args_base64": POOL_ARGS,
        }
        reply = self.rpc("query", params)
        if "result" not in reply or "result" not in reply["result"]:
            raise SourceDown(f"pool at {height}: {json.dumps(reply)[:200]}")
        return json.loads(bytes(reply["result"]["result"]))

    def trades(self, since, until):
        rows = []
        cursor = since * NANOS_PER_SECOND
        while True:
            url = TRADES_URL.format(since=cursor)
            reply = self.read(urllib.request.Request(url))
            if reply.get("error"):
                raise SourceDown(f"kraken: {reply['error']}")
            page = reply["result"][TRADE_PAIR]
            rows.extend(page)
            if len(page) < TRADE_PAGE or trade_seconds(page[-1]) > until:
                return rows
            cursor = int(reply["result"]["last"])


def block_at_or_above(sources, height, top):
    """The first real block from `height`, as `(height, seconds)`."""
    while height <= top:
        seconds = sources.block_seconds(height)
        if seconds is not None:
            return height, seconds
        height += 1
    return None


def first_block_of(sources, target):
    """The lowest block whose time is at or past `target`, by bisection over heights."""
    top = sources.tip()
    low, high = GENESIS_HEIGHT, top
    while low < high:
        middle = (low + high) // 2
        found = block_at_or_above(sources, middle, top)
        if found is not None and found[1] >= target:
            high = middle
        else:
            low = (found[0] if found else middle) + 1
    return block_at_or_above(sources, low, top), top


def pool_prices_in_second(sources, seconds):
    found, top = first_block_of(sources, seconds)
    prices = []
    while found is not None and found[1] == seconds:
        spot = pool_spot(sources.pool(found[0]))
        if spot is not None:
            prices.append(spot)
        found = block_at_or_above(sources, found[0] + 1, top)
    return prices


def trade_prices_in_second(sources, seconds):
    """A trade later in the same second may or may not have been there, so each ending counts."""
    since = seconds - TRADE_LOOKBACK_SECONDS
    rows = [row for row in sources.trades(since, seconds) if trade_seconds(row) <= seconds]
    endings = [index for index, row in enumerate(rows) if trade_seconds(row) == seconds]
    return [vwap(rows[max(0, end + 1 - TRADE_WINDOW) : end + 1]) for end in endings]


def check_price(report, name, expected, read):
    try:
        prices = read()
    except SourceDown as error:
        report.source_down = True
        report.skip(name, str(error))
        return
    report.check(name, expected in prices, f"reported {expected}, the source gives {prices}")


def check_proof(proof, sources):
    report = Report()
    cycles = proof["cycles"]
    if not cycles:
        report.check("proof has cycles", False, "no cycles")
    for cycle in cycles:
        decision = json.loads(cycle["decision"])
        nonce, obs = decision["nonce"], decision["obs"]
        if not obs["ta"] or not obs["tb"]:
            report.skip(f"nonce {nonce} pa", "the run could not read the market")
            report.skip(f"nonce {nonce} pb", "the run could not read the market")
            continue
        check_price(
            report,
            f"nonce {nonce} pa",
            int(obs["pa"]),
            lambda: pool_prices_in_second(sources, obs["ta"]),
        )
        check_price(
            report,
            f"nonce {nonce} pb",
            int(obs["pb"]),
            lambda: trade_prices_in_second(sources, obs["tb"]),
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("proof")
    args = parser.parse_args()
    with open(args.proof, encoding="utf-8") as proof_file:
        proof = json.load(proof_file)
    report = check_proof(proof, PublicSources())
    print("\n".join(report.lines))
    print(report.summary())
    return report.exit_code()


if __name__ == "__main__":
    sys.exit(main())
