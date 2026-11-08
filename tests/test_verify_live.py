"""Tier 1 of the verifier: `verify_live.py` reads a vault over public RPC. No test opens a connection."""

import ast
import base64
import contextlib
import copy
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import verify_live  # noqa: E402
from verify_live import TransportError  # noqa: E402

FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "live-synthetic.json").read_text(encoding="utf-8"))
VAULT = FIXTURE["vault"]
VIEWS = {"agent", "reveal_after", "revealed", "revealed_salt", "last_nonce", "stage",
         "published_decision", "ops_spent", "policy"}
FULL_ACCESS_KEY = {"public_key": "ed25519:AAAA", "access_key": {"nonce": 0, "permission": "FullAccess"}}
ALLOWED_IMPORTS = {"argparse", "dataclasses", "hashlib", "json", "pathlib", "re", "sys"}


class FakeChain:
    """Answers like a node: one block, one vault, the recorded views. `calls` lists every request."""

    def __init__(self, views=None, keys=None, block_ns=None, down=(), fail_status=None,
                 refused=(), account_error=None, code_hash=None):
        self.views = {**copy.deepcopy(FIXTURE["views"]), **(views or {})}
        self.keys = copy.deepcopy(FIXTURE["access_keys"] if keys is None else keys)
        self.block_ns = FIXTURE["block"]["timestamp_ns"] if block_ns is None else block_ns
        self.down = set(down)
        self.fail_status = fail_status
        self.refused = set(refused)
        self.account_error = account_error
        self.code_hash = code_hash or FIXTURE["code_hash_base58"]
        self.calls = []

    def __call__(self, url, payload):
        self.calls.append((url, payload))
        if self.fail_status is not None:
            raise TransportError(self.fail_status, "rate limited")
        if url in self.down:
            raise TransportError(None, "connection refused")
        return {"jsonrpc": "2.0", "id": "1", "result": self._result(payload)}

    def methods(self):
        return [self._name(payload) for _, payload in self.calls]

    @staticmethod
    def _name(payload):
        if payload["method"] == "block":
            return "block"
        params = payload["params"]
        return params.get("method_name", params["request_type"])

    def _height(self):
        return {"block_height": FIXTURE["block"]["height"], "block_hash": FIXTURE["block"]["hash"]}

    def _result(self, payload):
        if payload["method"] == "block":
            return {"header": {"height": FIXTURE["block"]["height"], "hash": FIXTURE["block"]["hash"],
                               "timestamp": self.block_ns, "timestamp_nanosec": str(self.block_ns)}}
        params = payload["params"]
        kind = params["request_type"]
        if self.account_error and kind in ("view_access_key_list", "view_account"):
            return {"error": self.account_error, "logs": [], **self._height()}
        if kind == "view_access_key_list":
            return {"keys": self.keys, **self._height()}
        if kind == "view_account":
            return {"amount": "1", "locked": "0", "code_hash": self.code_hash, "storage_usage": 1, **self._height()}
        assert kind == "call_function", kind
        assert params["account_id"] == VAULT
        name = params["method_name"]
        if name in self.refused:
            return {"error": "wasm execution failed with error: MethodResolveError(MethodNotFound)", "logs": [], **self._height()}
        if name == "published_decision":
            args = json.loads(base64.b64decode(params["args_base64"]))
            assert args == {"nonce": self.views["last_nonce"]}, args
        return {"result": list(json.dumps(self.views[name]).encode()), "logs": [], **self._height()}


def run(chain, *args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = verify_live.main(["--vault", VAULT, *args], transport=chain)
    return code, out.getvalue(), err.getvalue()


def results_of(text):
    return {line.split()[1].rstrip(":"): line.split()[0] for line in text.splitlines()
            if line.split()[:1] and line.split()[0] in ("PASS", "SKIP", "FAIL")}


def report(chain, **kwargs):
    client = verify_live.Client(verify_live.ENDPOINTS["testnet"], chain)
    return verify_live.run_live(VAULT, "testnet", client, **kwargs)


def by_name(rep):
    return {result.name: result for result in rep.results}


class ParsingTest(unittest.TestCase):
    def test_live_parses_each_view_method(self):
        chain = FakeChain()
        rep = report(chain)
        self.assertEqual(set(chain.methods()) & VIEWS, VIEWS)
        for name in VIEWS:
            self.assertEqual(chain.methods().count(name), 1, name)
        facts = rep.facts
        self.assertEqual(facts["access_keys"], 0)
        self.assertEqual(facts["code_hash"], FIXTURE["code_hash_hex"])
        self.assertEqual(facts["commitment"], FIXTURE["views"]["agent"]["commitment"])
        self.assertEqual(facts["reveal_after"], 1700000000)
        self.assertEqual(facts["stage"], "Idle")
        self.assertEqual(facts["last_nonce"], 7)
        self.assertEqual(facts["ops_spent"], "100")
        self.assertEqual(facts["policy"], FIXTURE["views"]["policy"])
        self.assertEqual(facts["block"], FIXTURE["block"]["height"])

    def test_a_raw_view_answer_is_decoded_from_its_bytes(self):
        raw = {"result": list(b'{"a":1}'), "logs": [], "block_height": 9, "block_hash": "x"}
        self.assertEqual(verify_live.decode_view(raw), {"a": 1})
        self.assertIsNone(verify_live.decode_view({"result": list(b"null"), "logs": []}))

    def test_a_base58_code_hash_becomes_the_hex_a_build_prints(self):
        self.assertEqual(verify_live.b58_to_hex(FIXTURE["code_hash_base58"]), FIXTURE["code_hash_hex"])
        self.assertEqual(verify_live.b58_to_hex("1" * 32), "00" * 32)

    def test_the_revealed_synthetic_vault_passes_and_the_text_carries_the_hero_facts(self):
        code, out, _ = run(FakeChain(), "--expect-code-hash", FIXTURE["code_hash_hex"])
        self.assertEqual(code, 0, out)
        self.assertEqual(results_of(out), {"keys": "PASS", "code_hash": "PASS", "commitment": "PASS", "decision": "PASS"})
        summary = out.strip().splitlines()[-1]
        for part in ("mode=live", "network=testnet", "keys=none", f"code_hash={FIXTURE['code_hash_hex']}",
                     f"commitment={FIXTURE['views']['agent']['commitment']}", "stage=Idle", "block=5000"):
            self.assertIn(part, summary)


class BudgetTest(unittest.TestCase):
    def test_live_call_count_at_most_15(self):
        healthy = FakeChain()
        report(healthy)
        self.assertLessEqual(len(healthy.calls), 15)
        down = FakeChain(fail_status=429)
        report(down)
        self.assertLessEqual(len(down.calls), 15)
        flaky = FakeChain(down=verify_live.ENDPOINTS["testnet"][:2])
        report(flaky)
        self.assertLessEqual(len(flaky.calls), 15)

    def test_live_uses_at_least_three_endpoints(self):
        for network, urls in verify_live.ENDPOINTS.items():
            self.assertGreaterEqual(len(set(urls)), 3, network)
        chain = FakeChain(down=verify_live.ENDPOINTS["testnet"][:2])
        rep = report(chain)
        self.assertEqual({url for url, _ in chain.calls}, set(verify_live.ENDPOINTS["testnet"]))
        self.assertEqual(by_name(rep)["keys"].status, "PASS", "the third endpoint answered")

    def test_a_dead_endpoint_does_not_stay_in_front(self):
        chain = FakeChain(down=verify_live.ENDPOINTS["testnet"][:1])
        report(chain)
        down_hits = sum(1 for url, _ in chain.calls if url == verify_live.ENDPOINTS["testnet"][0])
        self.assertLess(down_hits, len(chain.calls) / 2, "not every call tries the dead one first")


class NetworkFailureTest(unittest.TestCase):
    def test_live_429_becomes_skip_exit_2(self):
        code, out, _ = run(FakeChain(fail_status=429))
        self.assertEqual(code, 2, out)
        self.assertEqual(set(results_of(out).values()), {"SKIP"}, "a rate limit is never a failed claim")
        self.assertIn("NETWORK_", out)
        self.assertNotIn("FAIL", out)

    def test_a_network_that_is_down_is_exit_2_too(self):
        code, out, _ = run(FakeChain(down=verify_live.ENDPOINTS["testnet"]))
        self.assertEqual(code, 2, out)
        self.assertEqual(set(results_of(out).values()), {"SKIP"})

    def test_an_unknown_vault_account_is_a_tool_error_not_a_failed_claim(self):
        chain = FakeChain(account_error="account vault.owner.near does not exist while viewing")
        code, out, err = run(chain)
        self.assertEqual(code, 2)
        self.assertIn("ERROR", err)
        self.assertNotIn("PASS", out)


class ClaimTest(unittest.TestCase):
    def test_published_decision_null_is_skip_with_reason(self):
        code, out, _ = run(FakeChain(views={"published_decision": None}))
        self.assertEqual(code, 0, "an old nonce is not a failure and not a network problem")
        decision = by_name(report(FakeChain(views={"published_decision": None})))["decision"]
        self.assertEqual((decision.status, decision.reason), ("SKIP", "DECISION_NOT_KEPT"))
        self.assertIn("64", decision.detail)
        self.assertEqual(results_of(out)["decision"], "SKIP")

    def test_no_cycle_yet_is_a_skip_with_its_own_reason(self):
        rep = report(FakeChain(views={"last_nonce": 0, "published_decision": None}))
        self.assertEqual(by_name(rep)["decision"].reason, "DECISION_NO_CYCLES")

    def test_live_nonempty_access_keys_fail(self):
        code, out, _ = run(FakeChain(keys=[FULL_ACCESS_KEY]))
        self.assertEqual(code, 1, out)
        keys = by_name(report(FakeChain(keys=[FULL_ACCESS_KEY])))["keys"]
        self.assertEqual((keys.status, keys.reason), ("FAIL", "KEYS_NONEMPTY"))
        self.assertIn("keys=present", out.strip().splitlines()[-1])

    def test_missing_reveal_values_after_reveal_after_fail(self):
        for hidden in ({"revealed": None}, {"revealed_salt": None}, {"revealed": None, "revealed_salt": None}):
            with self.subTest(hidden):
                commitment = by_name(report(FakeChain(views=hidden)))["commitment"]
                self.assertEqual(commitment.status, "FAIL")
                self.assertIn(commitment.reason, ("REVEAL_MISSING", "COMMITMENT_FORMAT"))
        self.assertEqual(run(FakeChain(views={"revealed": None, "revealed_salt": None}))[0], 1)

    def test_before_reveal_after_the_commitment_is_a_skip_not_a_failure(self):
        before = (FIXTURE["views"]["reveal_after"] - 1000) * 10**9
        chain = FakeChain(views={"revealed": None, "revealed_salt": None}, block_ns=before)
        commitment = by_name(report(chain))["commitment"]
        self.assertEqual((commitment.status, commitment.reason), ("SKIP", "COMMITMENT_NOT_REVEALED"))
        self.assertEqual(run(chain)[0], 0)

    def test_revealed_values_that_do_not_open_the_commitment_fail(self):
        commitment = by_name(report(FakeChain(views={"revealed_salt": "ff" * 32})))["commitment"]
        self.assertEqual((commitment.status, commitment.reason), ("FAIL", "COMMITMENT_MISMATCH"))

    def test_the_code_hash_is_pinned_only_when_the_reader_gives_one(self):
        unpinned = by_name(report(FakeChain()))["code_hash"]
        self.assertEqual((unpinned.status, unpinned.reason), ("SKIP", "CODE_HASH_NOT_PINNED"))
        self.assertIn(FIXTURE["code_hash_hex"], unpinned.detail)
        right = by_name(report(FakeChain(), expect_code_hash=FIXTURE["code_hash_hex"]))["code_hash"]
        self.assertEqual(right.status, "PASS")
        wrong = by_name(report(FakeChain(), expect_code_hash="ab" * 32))["code_hash"]
        self.assertEqual((wrong.status, wrong.reason), ("FAIL", "CODE_HASH_MISMATCH"))

    def test_an_account_with_no_contract_fails(self):
        none = by_name(report(FakeChain(code_hash="1" * 32)))["code_hash"]
        self.assertEqual((none.status, none.reason), ("FAIL", "NO_CONTRACT"))

    def test_a_vault_without_a_view_skips_that_claim_instead_of_failing(self):
        decision = by_name(report(FakeChain(refused={"published_decision"})))["decision"]
        self.assertEqual((decision.status, decision.reason), ("SKIP", "VIEW_REFUSED"))
        self.assertIn("published_decision", decision.detail, "the reader is told which view the vault lacks")
        revealed = by_name(report(FakeChain(refused={"revealed_salt"})))["commitment"]
        self.assertEqual((revealed.status, revealed.reason), ("SKIP", "VIEW_REFUSED"))
        self.assertIn("revealed_salt", revealed.detail)


class OutputTest(unittest.TestCase):
    def test_json_carries_the_same_ids_as_the_text(self):
        _, text, _ = run(FakeChain())
        _, raw, _ = run(FakeChain(), "--json")
        data = json.loads(raw)
        self.assertEqual({r["name"]: r["status"] for r in data["results"]}, results_of(text))
        self.assertEqual(data["mode"], "live")
        self.assertEqual(data["network"], "testnet")
        self.assertEqual(data["vault"], VAULT)
        self.assertEqual(data["facts"]["stage"], "Idle")
        self.assertEqual(data["facts"]["block"], 5000)
        self.assertLessEqual(data["calls"], 15)
        self.assertEqual(data["summary"], {"pass": 3, "skip": 1, "fail": 0})

    def test_the_default_network_is_testnet_and_the_vault_is_required(self):
        chain = FakeChain()
        run(chain)
        self.assertLessEqual({url for url, _ in chain.calls}, set(verify_live.ENDPOINTS["testnet"]))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
            verify_live.main([], transport=FakeChain())
        self.assertEqual(stop.exception.code, 2)

    def test_no_vault_address_is_written_in_the_code(self):
        text = (ROOT / "verify_live.py").read_text(encoding="utf-8")
        text = re.sub(r"https?://\S+", "", text)
        self.assertEqual(re.findall(r"\b[a-z0-9_-]+\.(?:near|testnet)\b", text), [])


class StrictTest(unittest.TestCase):
    def test_strict_makes_a_skip_fail_live(self):
        chain = FakeChain(views={"published_decision": None})
        self.assertEqual(run(chain)[0], 0)
        self.assertEqual(run(chain, "--strict")[0], 1)

    def test_verify_strict_rejects_skip(self):
        proofs = ROOT / "proofs"
        with tempfile.TemporaryDirectory() as tmp:
            commitment = json.loads((proofs / "commitment.json").read_text())
            del commitment["params"], commitment["salt"]
            (Path(tmp) / "commitment.json").write_text(json.dumps(commitment))
            (Path(tmp) / "access_keys.json").write_text((proofs / "access_keys.json").read_text())
            plain = subprocess.run([sys.executable, str(ROOT / "verify.py"), "--proofs", tmp],
                                   capture_output=True, text=True)
            strict = subprocess.run([sys.executable, str(ROOT / "verify.py"), "--strict", "--proofs", tmp],
                                    capture_output=True, text=True)
        self.assertEqual(plain.returncode, 0, plain.stdout)
        self.assertIn("SKIP commitment", plain.stdout)
        self.assertEqual(strict.returncode, 1, strict.stdout)
        self.assertIn("SKIP commitment", strict.stdout)

    def test_the_committed_fixtures_pass_strict_with_the_golden_output(self):
        strict = subprocess.run([sys.executable, str(ROOT / "verify.py"), "--strict"],
                                capture_output=True, text=True)
        self.assertEqual(strict.returncode, 0, strict.stdout)
        golden = (ROOT / "proofs" / "expected" / "verify-offline.txt").read_text(encoding="utf-8")
        self.assertEqual(strict.stdout, golden)

    def test_make_has_verify_and_verify_strict(self):
        plan = subprocess.run(["make", "-n", "verify", "verify-strict"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertIn("python3 verify.py\n", plan.stdout)
        self.assertIn("python3 verify.py --strict", plan.stdout)


class OfflinePathTest(unittest.TestCase):
    def test_offline_path_imports_unchanged(self):
        tree = ast.parse((ROOT / "verify.py").read_text(encoding="utf-8"))
        top = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                top |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                top.add((node.module or "").split(".")[0])
        self.assertEqual(top, ALLOWED_IMPORTS, "the module level is what it was before --live")
        inside = {}
        for function in ast.walk(tree):
            if isinstance(function, ast.FunctionDef):
                for node in ast.walk(function):
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module]
                        inside.setdefault(function.name, set()).update(name.split(".")[0] for name in names)
        self.assertEqual(inside, {"main": {"verify_live"}}, "the only import in a function is verify_live, in main")
        everything = {name for names in inside.values() for name in names} | top
        self.assertFalse(everything & {"urllib", "socket"})


def run_verify_py(*args, blocked=True):
    """verify.py run as a script; sockets raise, so a stray connection cannot go out."""
    code = (
        "import runpy, socket, sys\n"
        "def blocked(*a, **k):\n    raise OSError('network blocked in the test')\n"
        "socket.socket.connect = blocked\nsocket.getaddrinfo = blocked\n"
        f"sys.argv = ['verify.py', *{list(args)!r}]\n"
        "try:\n    runpy.run_path(%r, run_name='__main__')\n" % str(ROOT / "verify.py") +
        "except SystemExit as stop:\n    code = stop.code\n"
        "else:\n    code = 0\n"
        "print('LOADED', 'verify_live' in sys.modules, file=sys.stderr)\n"
        "sys.exit(code)\n"
    )
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT)


class WiringTest(unittest.TestCase):
    def test_live_flag_hands_the_rest_to_verify_live(self):
        import verify
        from unittest import mock
        with mock.patch("verify_live.main", return_value=0) as live:
            self.assertEqual(verify.main(["--live", "--vault", "v.test", "--json", "--strict"]), 0)
        live.assert_called_once_with(["--vault", "v.test", "--json", "--strict"])
        with mock.patch("verify_live.main", return_value=2):
            self.assertEqual(verify.main(["--live", "--vault", "v.test"]), 2)

    def test_the_default_run_never_loads_verify_live(self):
        done = run_verify_py()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("LOADED False", done.stderr)
        golden = (ROOT / "proofs" / "expected" / "verify-offline.txt").read_text(encoding="utf-8")
        self.assertEqual(done.stdout, golden)

    def test_live_through_verify_py_is_skip_exit_2_when_the_network_is_down(self):
        done = run_verify_py("--live", "--vault", VAULT)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn("LOADED True", done.stderr)
        self.assertIn("verify live (tier 1)", done.stdout)
        self.assertNotIn("FAIL", done.stdout)
        self.assertIn("NETWORK_", done.stdout)

    def test_live_without_a_vault_is_a_usage_error(self):
        done = run_verify_py("--live")
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)


class FakeClock:
    """A clock the test owns: `sleep` moves it forward and records the pause. Nothing really waits."""

    def __init__(self):
        self.now = 1000.0
        self.pauses = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.pauses.append(seconds)
        self.now += seconds


def paced_client(chain, clock):
    """A Client on `chain` whose requests are stamped with the fake time they were sent."""
    sent = []

    def transport(url, payload):
        sent.append((clock(), url))
        return chain(url, payload)

    client = verify_live.Client(verify_live.ENDPOINTS["testnet"], transport, sleep=clock.sleep, clock=clock)
    return client, sent


class PacingTest(unittest.TestCase):
    def test_twelve_reads_stay_under_three_requests_a_minute_per_endpoint(self):
        clock = FakeClock()
        client, sent = paced_client(FakeChain(), clock)
        rep = verify_live.run_live(VAULT, "testnet", client)
        self.assertEqual(len(sent), 12, "a full run is twelve reads")
        self.assertEqual(by_name(rep)["keys"].status, "PASS")
        for url in verify_live.ENDPOINTS["testnet"]:
            times = [at for at, sent_to in sent if sent_to == url]
            for first, fourth in zip(times, times[3:]):
                self.assertGreaterEqual(fourth - first, 60.0, f"four requests to {url} within a minute")

    def test_the_wait_is_bounded_by_one_window(self):
        clock = FakeClock()
        client, _ = paced_client(FakeChain(), clock)
        verify_live.run_live(VAULT, "testnet", client)
        self.assertTrue(clock.pauses, "twelve reads over three endpoints do need a pause")
        self.assertLessEqual(sum(clock.pauses), 60.0)

    def test_a_short_run_does_not_wait(self):
        clock = FakeClock()
        client, sent = paced_client(FakeChain(), clock)
        for _ in range(9):
            client.call("block", {"finality": "final"})
        self.assertEqual(len(sent), 9)
        self.assertEqual(clock.pauses, [])

    def test_the_call_budget_still_holds_while_pacing(self):
        clock = FakeClock()
        client, sent = paced_client(FakeChain(fail_status=500), clock)
        with self.assertRaises(verify_live.Unavailable):
            for _ in range(20):
                client.call("block", {"finality": "final"})
        self.assertLessEqual(len(sent), verify_live.MAX_CALLS)

    def test_an_endpoint_that_answered_429_is_not_asked_again_in_the_run(self):
        clock = FakeClock()
        limited = verify_live.ENDPOINTS["testnet"][0]
        chain = FakeChain()
        sent = []

        def transport(url, payload):
            sent.append(url)
            if url == limited:
                raise TransportError(429, "too many requests")
            return chain(url, payload)

        client = verify_live.Client(verify_live.ENDPOINTS["testnet"], transport, sleep=clock.sleep, clock=clock)
        rep = verify_live.run_live(VAULT, "testnet", client)
        self.assertEqual(sent.count(limited), 1, "one 429, then the other two endpoints carry the run")
        self.assertEqual(by_name(rep)["keys"].status, "PASS")

    def test_when_every_endpoint_said_429_the_run_gives_up_without_waiting(self):
        clock = FakeClock()
        client, sent = paced_client(FakeChain(fail_status=429), clock)
        with self.assertRaises(verify_live.Unavailable) as caught:
            client.call("block", {"finality": "final"})
        self.assertTrue(caught.exception.reason.startswith("NETWORK_"))
        with self.assertRaises(verify_live.Unavailable):
            client.call("block", {"finality": "final"})
        self.assertEqual(len(sent), 3, "each endpoint is tried once and then left alone")
        self.assertEqual(clock.pauses, [])

    def test_a_main_run_on_an_injected_transport_never_sleeps(self):
        from unittest import mock
        with mock.patch("time.sleep", side_effect=AssertionError("slept")):
            code, out, _ = run(FakeChain(fail_status=429))
            self.assertEqual(code, 2, out)
            code, out, _ = run(FakeChain())
            self.assertEqual(code, 0, out)


class NodeErrorChain(FakeChain):
    """A node that answers `method` with a node-side JSON-RPC error, on all endpoints or only on `only`."""

    def __init__(self, method, error, only=(), **kwargs):
        super().__init__(**kwargs)
        self.method, self.error, self.only = method, error, set(only)

    def __call__(self, url, payload):
        if self._name(payload) == self.method and (not self.only or url in self.only):
            self.calls.append((url, payload))
            return {"jsonrpc": "2.0", "id": "1", "error": self.error}
        return super().__call__(url, payload)


INTERNAL = {"name": "INTERNAL_ERROR", "cause": {"name": "INTERNAL_ERROR", "info": {"error_message": "boom"}},
            "code": -32000, "message": "Server error", "data": "boom"}
TIMEOUT = {"name": "HANDLER_ERROR", "cause": {"name": "TIMEOUT_ERROR", "info": {}},
           "code": -32000, "message": "Server error", "data": "Timeout"}
TIMEOUT_TOP = {"name": "TIMEOUT_ERROR", "cause": {"name": "TIMEOUT_ERROR", "info": {}},
               "code": -32000, "message": "Server error", "data": "Timeout"}
NODE_ERRORS = {"internal": INTERNAL, "timeout in cause": TIMEOUT, "timeout at top": TIMEOUT_TOP}


class NodeErrorTest(unittest.TestCase):
    def test_a_node_side_error_on_one_endpoint_is_retried_on_the_next(self):
        urls = verify_live.ENDPOINTS["testnet"]
        for label, error in NODE_ERRORS.items():
            with self.subTest(error=label):
                chain = NodeErrorChain("stage", error, only=urls[:1])
                client = verify_live.Client(urls, chain)
                value, _ = client.view(VAULT, "stage")  # a fresh client asks the first endpoint first
                self.assertEqual(value, "Idle", "the second endpoint answered the view")
                self.assertEqual([url for url, _ in chain.calls], urls[:2])
                rep = report(NodeErrorChain("stage", error, only=urls[:2]))
                self.assertNotIn("VIEW_REFUSED", {r.reason for r in rep.results})

    def test_a_node_side_error_on_every_endpoint_is_exit_2_and_not_a_refused_view(self):
        for label, error in NODE_ERRORS.items():
            with self.subTest(error=label):
                code, out, _ = run(NodeErrorChain("published_decision", error))
                self.assertEqual(code, 2, out)
                self.assertIn("NETWORK_", out)
                self.assertNotIn("VIEW_REFUSED", out)
                self.assertNotIn("FAIL", out)

    def test_a_node_side_error_counts_against_the_call_budget(self):
        chain = NodeErrorChain("block", INTERNAL)
        report(chain)
        self.assertLessEqual(len(chain.calls), verify_live.MAX_CALLS)

    def test_other_json_rpc_errors_are_still_refused(self):
        unknown = {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_ACCOUNT", "info": {}}, "code": -32000,
                   "message": "Server error", "data": "no such account"}
        code, out, err = run(NodeErrorChain("view_account", unknown))
        self.assertEqual(code, 2, out + err)
        self.assertIn("ERROR cannot read the vault account", err)


class ImportGuardTest(unittest.TestCase):
    """test_verify_offline.py allows `verify_live` anywhere in verify.py; this pins where it may be."""

    @staticmethod
    def live_imports_outside_main(source):
        def names(node):
            return [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]

        tree = ast.parse(source)
        found = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))
                 and any(name.split(".")[0] == "verify_live" for name in names(n))]
        for function in (n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name != "main"):
            found += [n for n in ast.walk(function) if isinstance(n, (ast.Import, ast.ImportFrom))
                      and any(name.split(".")[0] == "verify_live" for name in names(n))]
        return found

    def test_verify_py_imports_verify_live_only_inside_main(self):
        source = (ROOT / "verify.py").read_text(encoding="utf-8")
        self.assertEqual(self.live_imports_outside_main(source), [])
        self.assertIn("import verify_live", source, "main still loads it for --live")

    def test_the_guard_catches_an_import_moved_to_the_top_or_into_another_function(self):
        source = (ROOT / "verify.py").read_text(encoding="utf-8")
        self.assertTrue(self.live_imports_outside_main("import verify_live\n" + source))
        self.assertTrue(self.live_imports_outside_main("from verify_live import main as live\n" + source))
        elsewhere = source.replace("def main(argv=None):", "def helper():\n    import verify_live\n\n\ndef main(argv=None):", 1)
        self.assertNotEqual(elsewhere, source)
        self.assertTrue(self.live_imports_outside_main(elsewhere))


if __name__ == "__main__":
    unittest.main()
