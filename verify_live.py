#!/usr/bin/env python3
"""Foundling verifier, tier 1: read one vault over public RPC. Read-only, no key, no signing.

Standard library only. The offline path (`verify.py`) never imports this module, so it never
opens a connection. At most 15 calls per run, spread over three endpoints.
Exit codes: 0 no claim failed, 1 a claim failed (or a SKIP, with --strict), 2 the network or
the tool could not answer: a rate limit or a dead node is a SKIP, never a failed claim.
"""

import argparse
import base64
import datetime
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

import verify

ENDPOINTS = {
    "testnet": ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"],
    "mainnet": ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org", "https://rpc.mainnet.fastnear.com"],
}
MAX_CALLS = 15
TIMEOUT = 20
# Public nodes without a key answer about 3 requests a minute each (SPEC 11, item 3).
RATE_LIMIT = 3
RATE_WINDOW = 60.0
# JSON-RPC errors that say the node failed, not the vault: try the next endpoint.
NODE_ERRORS = {"INTERNAL_ERROR", "TIMEOUT_ERROR"}
DECISIONS_KEPT = 64
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

EXIT_OK, EXIT_FAIL, EXIT_TOOL = verify.EXIT_OK, verify.EXIT_FAIL, verify.EXIT_TOOL


class TransportError(Exception):
    """One request failed: a status code (429 included) or no answer at all."""

    def __init__(self, status=None, message="", retry_after=None):
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status
        self.retry_after = retry_after  # seconds the node asked us to wait, when it said so


class Unavailable(Exception):
    """No endpoint answered, or the budget is spent. A claim that needed it is a SKIP."""

    def __init__(self, reason, detail):
        super().__init__(detail)
        self.reason = reason


class Refused(Exception):
    """The node answered, but the vault or the account did not."""


def http_transport(url, payload, timeout=TIMEOUT):
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        raise TransportError(err.code, str(err.reason), retry_after_seconds(err.headers)) from err
    except (urllib.error.URLError, OSError, ValueError) as err:
        raise TransportError(None, str(err)) from err


def retry_after_seconds(headers):
    """The Retry-After header as a number of seconds, or None (absent, a date, negative or not finite)."""
    try:
        value = float((headers.get("Retry-After") if headers is not None else None) or "")
    except ValueError:
        return None
    return value if 0 <= value < float("inf") else None


def is_node_error(error):
    """A JSON-RPC error object that names a node-side failure, in its name or in its cause."""
    if not isinstance(error, dict):
        return False
    cause = error.get("cause")
    names = {error.get("name"), cause.get("name") if isinstance(cause, dict) else None}
    return bool(names & NODE_ERRORS)


class Client:
    """JSON-RPC over several endpoints with a hard cap on calls. A failing endpoint goes behind the others.

    With a `sleep`, each endpoint gets at most RATE_LIMIT requests per RATE_WINDOW seconds, and a 429 is
    waited out once: the Retry-After the node sent (else one window, never more than one window), then the
    same endpoint is asked again. A second 429 leaves it alone for the rest of the run. Without a `sleep`
    nothing waits and the first 429 leaves the endpoint alone. Every try counts against the call budget.
    """

    def __init__(self, endpoints, transport=http_transport, max_calls=MAX_CALLS, sleep=None, clock=time.monotonic):
        self.endpoints = list(endpoints)
        self.transport = transport
        self.max_calls = max_calls
        self.sleep = sleep
        self.clock = clock
        self.calls = 0
        self._failures = [0] * len(self.endpoints)
        self._limited = [False] * len(self.endpoints)
        self._waited = [False] * len(self.endpoints)
        self._sent = [[] for _ in self.endpoints]
        self._start = 0

    def _wait(self, index):
        """Seconds until this endpoint may be asked again without passing its rate (0 when not pacing)."""
        if self.sleep is None:
            return 0.0
        now = self.clock()
        recent = [at for at in self._sent[index] if now - at < RATE_WINDOW]
        self._sent[index] = recent
        return max(0.0, recent[-RATE_LIMIT] + RATE_WINDOW - now) if len(recent) >= RATE_LIMIT else 0.0

    def call(self, method, params):
        count = len(self.endpoints)
        usable = [i for i in range(count) if not self._limited[i]]
        if not usable:
            raise Unavailable("NETWORK_UNAVAILABLE", f"{method}: every endpoint answered 429 in this run")
        order = sorted(usable, key=lambda i: (self._failures[i], self._wait(i), (i - self._start) % count))
        self._start += 1
        last = None
        for index in order:
            while not self._limited[index]:
                if self.calls >= self.max_calls:
                    raise Unavailable("NETWORK_BUDGET", f"the budget of {self.max_calls} calls is used up")
                self.calls += 1
                wait = self._wait(index)
                if wait > 0:
                    self.sleep(wait)
                if self.sleep is not None:
                    self._sent[index].append(self.clock())
                payload = {"jsonrpc": "2.0", "id": "verify", "method": method, "params": params}
                try:
                    data = self.transport(self.endpoints[index], payload)
                except TransportError as err:
                    if err.status is None and self._sent[index]:
                        self._sent[index].pop()  # no answer at all: the node never counted this request
                    self._failures[index] += 1
                    last = err
                    if err.status == 429:
                        if self.sleep is None or self._waited[index]:
                            self._limited[index] = True
                        else:
                            self._waited[index] = True
                            self.sleep(min(err.retry_after if err.retry_after is not None else RATE_WINDOW, RATE_WINDOW))
                            self._sent[index].clear()  # the pause was the node's own window
                            continue
                    break
                if isinstance(data, dict) and is_node_error(data.get("error")):
                    self._failures[index] += 1
                    last = TransportError(None, f"node error {json.dumps(data['error'])[:80]}")
                    break
                if isinstance(data, dict) and ("result" in data or "error" in data):
                    return data
                self._failures[index] += 1
                last = TransportError(None, "not a JSON-RPC answer")
                break
        raise Unavailable("NETWORK_UNAVAILABLE", f"{method}: no endpoint answered ({last})")

    def result(self, method, params):
        data = self.call(method, params)
        if "error" in data:
            raise Refused(json.dumps(data["error"])[:200])
        result = data["result"]
        if isinstance(result, dict) and isinstance(result.get("error"), str):
            raise Refused(result["error"][:200])
        return result

    def query(self, request_type, **params):
        return self.result("query", {"request_type": request_type, "finality": "final", **params})

    def view(self, vault, method, args=None):
        raw = json.dumps(args or {}).encode()
        result = self.query("call_function", account_id=vault, method_name=method,
                            args_base64=base64.b64encode(raw).decode())
        return decode_view(result), result.get("block_height")


def decode_view(result):
    try:
        return json.loads(bytes(result["result"]).decode("utf-8"))
    except (KeyError, TypeError, ValueError) as err:
        raise Refused("the view answer is not JSON") from err


def b58_to_hex(text):
    number = 0
    for char in text:
        if char not in B58:
            raise verify.ToolError("the code hash is not base58")
        number = number * 58 + B58.index(char)
    body = number.to_bytes((number.bit_length() + 7) // 8, "big")
    raw = b"\0" * (len(text) - len(text.lstrip("1"))) + body
    if len(raw) != 32:
        raise verify.ToolError("the code hash is not 32 bytes")
    return raw.hex()


@dataclass
class Problem:
    reason: str
    detail: str


@dataclass
class Report:
    vault: str
    network: str
    results: list = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    calls: int = 0


def iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat(timespec="seconds")


def attempt(thunk):
    """(value, height) of a read, or a Problem for a network failure or a refused view."""
    try:
        return thunk()
    except Unavailable as err:
        return Problem(err.reason, str(err))
    except Refused as err:
        return Problem("VIEW_REFUSED", str(err))


def account_read(thunk, what):
    """The account itself must be readable: a missing vault is a tool error, not a failed claim."""
    try:
        return thunk()
    except Refused as err:
        raise verify.ToolError(f"cannot read {what}: {err}") from err
    except Unavailable as err:
        return Problem(err.reason, str(err))


def run_live(vault, network, client, expect_code_hash=None):
    verify.require_account(vault, "--vault")
    report = Report(vault, network)
    facts, results = report.facts, report.results

    def add(name, status, reason, detail):
        results.append(verify.Result(name, status, reason, detail))

    def skip_for(name, problem):
        add(name, "SKIP", problem.reason, problem.detail)

    keys = account_read(lambda: client.query("view_access_key_list", account_id=vault), "the vault's access keys")
    if isinstance(keys, Problem):
        skip_for("keys", keys)
        facts["access_keys"] = None
    else:
        count, height = len(keys["keys"]), keys.get("block_height")
        facts["access_keys"] = count
        if count:
            add("keys", "FAIL", "KEYS_NONEMPTY", f"{count} access key(s) for {vault} at block {height}; a sealed vault has none")
        else:
            add("keys", "PASS", "", f"access key list is empty for {vault} at block {height}")

    account = account_read(lambda: client.query("view_account", account_id=vault), "the vault account")
    if isinstance(account, Problem):
        skip_for("code_hash", account)
        facts["code_hash"] = None
    else:
        code_hash = b58_to_hex(account["code_hash"])
        facts["code_hash"] = code_hash
        if code_hash == "00" * 32:
            add("code_hash", "FAIL", "NO_CONTRACT", f"{vault} has no contract deployed")
        elif expect_code_hash is None:
            add("code_hash", "SKIP", "CODE_HASH_NOT_PINNED",
                f"the vault runs {code_hash}; pass --expect-code-hash with the hash of the reproducible build to compare")
        elif code_hash == expect_code_hash:
            add("code_hash", "PASS", "", f"vault code hash {code_hash} equals the expected build")
        else:
            add("code_hash", "FAIL", "CODE_HASH_MISMATCH", f"the vault runs {code_hash}, expected {expect_code_hash}")

    def view(method, args=None):
        read = attempt(lambda: client.view(vault, method, args))
        if isinstance(read, Problem) and read.reason == "VIEW_REFUSED":
            return Problem(read.reason, f"the vault has no usable view {method}: {read.detail}")
        return read

    def value(read):
        return None if isinstance(read, Problem) else read[0]

    agent = view("agent")
    reveal_after = view("reveal_after")
    revealed = view("revealed")
    salt = view("revealed_salt")
    block = attempt(lambda: client.result("block", {"finality": "final"}))
    stage = view("stage")
    last_nonce = view("last_nonce")

    config = value(agent)
    facts["commitment"] = config.get("commitment") if isinstance(config, dict) else None
    facts["reveal_after"] = value(reveal_after)
    facts["last_nonce"] = value(last_nonce)
    facts["stage"] = None
    facts["block"] = None
    if not isinstance(stage, Problem):
        kind = stage[0]
        facts["stage"] = kind if isinstance(kind, str) else next(iter(kind), None) if isinstance(kind, dict) else None
        facts["block"] = stage[1]
    chain_time = None if isinstance(block, Problem) else block["header"]["timestamp"] // 10**9

    results.append(commitment_result(vault, agent, reveal_after, revealed, salt, chain_time, block))
    results.append(decision_result(view, last_nonce))
    facts["ops_spent"] = value(view("ops_spent"))
    facts["policy"] = value(view("policy"))
    report.calls = client.calls
    return report


def commitment_result(vault, agent, reveal_after, revealed, salt, chain_time, block):
    def result(status, reason, detail):
        return verify.Result("commitment", status, reason, detail)

    for read in (agent, revealed, salt):
        if isinstance(read, Problem):
            return result("SKIP", read.reason, read.detail)
    config = agent[0]
    if not isinstance(config, dict) or not isinstance(config.get("commitment"), str):
        return result("FAIL", "COMMITMENT_FORMAT", "the vault's agent view has no commitment")
    commitment = config["commitment"]
    if not verify.HEX64.fullmatch(commitment):
        return result("FAIL", "COMMITMENT_FORMAT", "commitment is not 64 lowercase hex characters")
    params, secret = revealed[0], salt[0]
    if params is None or secret is None:
        for late in (reveal_after, block):
            if isinstance(late, Problem):
                return result("SKIP", late.reason, late.detail)
        opens_at = reveal_after[0]
        if not isinstance(opens_at, int) or isinstance(opens_at, bool):
            return result("FAIL", "COMMITMENT_FORMAT", "reveal_after is not a number of seconds")
        if chain_time < opens_at:
            if params is None and secret is None:
                return result("SKIP", "COMMITMENT_NOT_REVEALED",
                              f"params and salt are published at reveal; reveal_after is {iso(opens_at)}, "
                              f"chain time is {iso(chain_time)}")
            return result("FAIL", "COMMITMENT_FORMAT", "only one of params and salt is set before reveal_after")
        missing = " and ".join(name for name, got in (("params", params), ("salt", secret)) if got is None)
        return result("FAIL", "REVEAL_MISSING",
                      f"reveal_after ({iso(opens_at)}) has passed and the vault holds no {missing} to open the commitment")
    if not isinstance(params, str) or not isinstance(secret, str) or not verify.HEX64.fullmatch(secret):
        return result("FAIL", "COMMITMENT_FORMAT", "params and salt must be text, with a 32-byte hex salt")
    expected = verify.hash_fields(
        verify.COMMITMENT_TAG,
        [str(config.get("chain")).encode(), vault.encode(), str(config.get("wasm_hash")).encode(),
         params.encode(), bytes.fromhex(secret)],
    )
    if expected != commitment:
        return result("FAIL", "COMMITMENT_MISMATCH", "recomputed sha256 differs from the commitment on chain")
    return result("PASS", "", "the revealed params and salt open the commitment on chain")


def decision_result(view, last_nonce):
    def result(status, reason, detail):
        return verify.Result("decision", status, reason, detail)

    if isinstance(last_nonce, Problem):
        return result("SKIP", last_nonce.reason, last_nonce.detail)
    nonce = last_nonce[0]
    if not isinstance(nonce, int) or isinstance(nonce, bool):
        return result("FAIL", "DECISION_FORMAT", "last_nonce is not a number")
    if nonce == 0:
        return result("SKIP", "DECISION_NO_CYCLES", "the vault has not run a cycle yet")
    read = view("published_decision", {"nonce": nonce})
    if isinstance(read, Problem):
        return result("SKIP", read.reason, read.detail)
    decision = read[0]
    if decision is None:
        return result("SKIP", "DECISION_NOT_KEPT",
                      f"the slot for nonce {nonce} holds no decision: the vault keeps the last {DECISIONS_KEPT} "
                      "(nonce % 64), or that cycle ended without one")
    if not isinstance(decision, str):
        return result("FAIL", "DECISION_FORMAT", "published_decision did not return text")
    raw = decision.encode()
    return result("PASS", "", f"the decision for nonce {nonce} is kept: {len(raw)} bytes, sha256 {hashlib.sha256(raw).hexdigest()}")


def keys_label(report):
    count = report.facts.get("access_keys")
    return "unchecked" if count is None else "none" if count == 0 else "present"


def tally(report):
    return {status.lower(): sum(r.status == status for r in report.results) for status in ("PASS", "SKIP", "FAIL")}


def exit_code(report, strict=False):
    counts = tally(report)
    if counts["fail"]:
        return EXIT_FAIL
    if any(r.status == "SKIP" and r.reason.startswith("NETWORK_") for r in report.results):
        return EXIT_TOOL
    return EXIT_FAIL if strict and counts["skip"] else EXIT_OK


def render_text(report):
    counts, facts = tally(report), report.facts
    block = facts.get("block")
    lines = [f"verify live (tier 1) network={report.network} vault={report.vault}"]
    lines += [result.line() for result in report.results]
    lines.append(
        f"SUMMARY pass={counts['pass']} skip={counts['skip']} fail={counts['fail']} mode=live "
        f"network={report.network} keys={keys_label(report)} code_hash={facts.get('code_hash') or 'unknown'} "
        f"commitment={facts.get('commitment') or 'unknown'} stage={facts.get('stage') or 'unknown'} "
        f"block={'unknown' if block is None else block} calls={report.calls}"
    )
    return "\n".join(lines)


def render_json(report, code):
    return json.dumps({
        "mode": "live", "network": report.network, "vault": report.vault,
        "results": [{"name": r.name, "status": r.status, "reason": r.reason, "detail": r.detail}
                    for r in report.results],
        "facts": report.facts, "summary": tally(report), "calls": report.calls, "exit": code,
    }, indent=2, sort_keys=True)


def main(argv=None, transport=http_transport):
    parser = argparse.ArgumentParser(prog="verify_live.py", description="Foundling tier 1 live read-only verifier")
    parser.add_argument("--vault", required=True, help="the vault's account id")
    parser.add_argument("--network", choices=sorted(ENDPOINTS), default="testnet")
    parser.add_argument("--expect-code-hash", help="sha256 (hex) of the reproducible vault build")
    parser.add_argument("--json", action="store_true", help="print one JSON object with the same ids")
    parser.add_argument("--strict", action="store_true", help="a SKIP also fails")
    args = parser.parse_args(argv)
    try:
        expected = args.expect_code_hash
        if expected is not None:
            expected = expected.lower()
            if not verify.HEX64.fullmatch(expected):
                raise verify.ToolError("--expect-code-hash must be 64 hex characters")
        # Only the real network is paced; a test's stand-in transport answers at once.
        client = Client(ENDPOINTS[args.network], transport, sleep=time.sleep if transport is http_transport else None)
        report = run_live(args.vault, args.network, client, expected)
    except verify.ToolError as err:
        print(f"ERROR {err}", file=sys.stderr)
        return EXIT_TOOL
    except Exception as err:  # an odd answer must never look like a failed claim
        print(f"ERROR unexpected {type(err).__name__} while reading the vault", file=sys.stderr)
        return EXIT_TOOL
    code = exit_code(report, args.strict)
    print(render_json(report, code) if args.json else render_text(report))
    return code


if __name__ == "__main__":
    sys.exit(main())
