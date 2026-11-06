import ast
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import verify  # noqa: E402

PROOFS = ROOT / "proofs"
GOLDEN = PROOFS / "expected" / "verify-offline.txt"
RUST_VECTOR = ROOT / "strategy" / "fixtures" / "commitment.json"
FULL_ACCESS_KEY = {"public_key": "ed25519:AAAA", "access_key": {"nonce": 0, "permission": "FullAccess"}}
ALLOWED_IMPORTS = {"argparse", "dataclasses", "hashlib", "json", "pathlib", "re", "sys"}


def load(name):
    return json.loads((PROOFS / name).read_text(encoding="utf-8"))


def with_keys(fixture, keys):
    out = copy.deepcopy(fixture)
    out["response"]["result"]["keys"] = keys
    return out


def run_cli(*args, proofs=PROOFS):
    return subprocess.run(
        [sys.executable, str(ROOT / "verify.py"), "--proofs", str(proofs), *args],
        capture_output=True,
        text=True,
    )


def stage(tmp, commitment=None, keys=None):
    out = Path(tmp)
    for name, given in (("commitment.json", commitment), ("access_keys.json", keys)):
        content = load(name) if given is None else given
        text = content if isinstance(content, str) else json.dumps(content)
        (out / name).write_text(text, encoding="utf-8")
    return out


def run_staged(*args, commitment=None, keys=None):
    with tempfile.TemporaryDirectory() as tmp:
        return run_cli(*args, proofs=stage(tmp, commitment, keys))


def commitment_without(*fields):
    out = copy.deepcopy(load("commitment.json"))
    for field in fields:
        del out[field]
    return out


class VerifyOffline(unittest.TestCase):
    def test_verify_commitment_check_pass_on_good_fixture(self):
        result = verify.check_commitment(load("commitment.json"))
        self.assertEqual(result.status, "PASS")

    def test_verify_commitment_agrees_with_the_rust_vector(self):
        result = verify.check_commitment(json.loads(RUST_VECTOR.read_text(encoding="utf-8")))
        self.assertEqual(result.status, "PASS")

    def test_the_bundle_vector_is_the_rust_vector(self):
        # Two copies of one vector drift apart silently, as they did when `prompt` was added.
        bundle = load("commitment.json")
        rust = json.loads(RUST_VECTOR.read_text(encoding="utf-8"))
        for field in ("chain", "vault", "wasm_hash", "params", "salt", "commitment"):
            self.assertEqual(bundle[field], rust[field], field)

    def test_verify_commitment_check_fail_on_tampered_fixture(self):
        tampered = copy.deepcopy(load("commitment.json"))
        tampered["params"] = tampered["params"].replace("1000", "9999")
        result = verify.check_commitment(tampered)
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.reason, "COMMITMENT_MISMATCH")

        malformed = copy.deepcopy(load("commitment.json"))
        malformed["commitment"] = "not-hex"
        result = verify.check_commitment(malformed)
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.reason, "COMMITMENT_FORMAT")

    def test_verify_commitment_skips_while_params_and_salt_are_unrevealed(self):
        result = verify.check_commitment(commitment_without("params", "salt"))
        self.assertEqual(result.status, "SKIP")
        self.assertEqual(result.reason, "COMMITMENT_NOT_REVEALED")

    def test_verify_commitment_fails_when_only_one_of_params_and_salt_is_given(self):
        for missing in ("params", "salt"):
            result = verify.check_commitment(commitment_without(missing))
            self.assertEqual(result.status, "FAIL", missing)
            self.assertEqual(result.reason, "COMMITMENT_FORMAT", missing)

    def test_verify_keys_check_fails_if_keys_nonempty(self):
        keys = with_keys(load("access_keys.json"), [FULL_ACCESS_KEY])
        result = verify.check_keys(keys, load("commitment.json"))
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.reason, "KEYS_NONEMPTY")

    def test_verify_keys_check_fails_for_another_account(self):
        other = copy.deepcopy(load("access_keys.json"))
        other["account_id"] = "attacker.near"
        result = verify.check_keys(other, load("commitment.json"))
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.reason, "KEYS_WRONG_ACCOUNT")

    def test_verify_keys_check_reports_the_block_height(self):
        result = verify.check_keys(load("access_keys.json"), load("commitment.json"))
        self.assertEqual(result.status, "PASS")
        self.assertIn("at block 1000", result.detail)

    def test_verify_results_are_labelled_synthetic(self):
        commitment, keys = load("commitment.json"), load("access_keys.json")
        results = [verify.check_commitment(commitment), verify.check_keys(keys, commitment)]
        for result in results:
            self.assertTrue(result.synthetic, result.name)
            self.assertIn("[synthetic]", result.line())

        commitment.pop("synthetic")
        keys.pop("synthetic")
        results = [verify.check_commitment(commitment), verify.check_keys(keys, commitment)]
        for result in results:
            self.assertFalse(result.synthetic, result.name)
            self.assertNotIn("synthetic", result.line())

    def test_verify_refuses_account_text_that_could_forge_report_lines(self):
        forged = "x\nSUMMARY pass=9 skip=0 fail=0 mode=offline keys=none"
        keys = copy.deepcopy(load("access_keys.json"))
        keys["account_id"] = forged
        with self.assertRaises(verify.ToolError):
            verify.check_keys(keys, load("commitment.json"))
        commitment = copy.deepcopy(load("commitment.json"))
        commitment["vault"] = forged
        with self.assertRaises(verify.ToolError):
            verify.check_commitment(commitment)

    def test_verify_offline_output_matches_golden_snapshot(self):
        result = run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, GOLDEN.read_text(encoding="utf-8"))

    def test_verify_exit_code_contract(self):
        bad = copy.deepcopy(load("commitment.json"))
        bad["salt"] = "00" * 32
        for sub in ([], ["commitment"], ["keys"]):
            self.assertEqual(run_cli(*sub).returncode, 0, sub)
        self.assertEqual(run_staged("commitment", commitment=bad).returncode, 1)
        self.assertEqual(run_staged(commitment=bad).returncode, 1)
        self.assertEqual(run_staged("keys", commitment=bad).returncode, 0)

        with tempfile.TemporaryDirectory() as empty:
            for sub in ([], ["commitment"], ["keys"]):
                self.assertEqual(run_cli(*sub, proofs=empty).returncode, 2, sub)
        self.assertEqual(run_cli("no-such-subcommand").returncode, 2)

    def test_verify_summary_line_and_exit_code_table(self):
        tampered = copy.deepcopy(load("commitment.json"))
        tampered["salt"] = "00" * 32
        other_account = copy.deepcopy(load("access_keys.json"))
        other_account["account_id"] = "attacker.near"
        cases = [
            ("all good", [], {}, 0, "SUMMARY pass=2 skip=0 fail=0 mode=offline keys=none"),
            ("tampered commitment", [], {"commitment": tampered}, 1, "SUMMARY pass=1 skip=0 fail=1 mode=offline keys=none"),
            (
                "keys present",
                [],
                {"keys": with_keys(load("access_keys.json"), [FULL_ACCESS_KEY])},
                1,
                "SUMMARY pass=1 skip=0 fail=1 mode=offline keys=present",
            ),
            ("another account", [], {"keys": other_account}, 1, "SUMMARY pass=1 skip=0 fail=1 mode=offline keys=unverified"),
            (
                "unrevealed",
                [],
                {"commitment": commitment_without("params", "salt")},
                0,
                "SUMMARY pass=1 skip=1 fail=0 mode=offline keys=none",
            ),
            ("commitment only", ["commitment"], {}, 0, "SUMMARY pass=1 skip=0 fail=0 mode=offline keys=unchecked"),
            ("keys only", ["keys"], {}, 0, "SUMMARY pass=1 skip=0 fail=0 mode=offline keys=none"),
        ]
        for label, args, fixtures, code, last in cases:
            with self.subTest(label):
                result = run_staged(*args, **fixtures)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(result.stdout.splitlines()[-1], last)

    def test_verify_input_problems_exit_2_without_a_report(self):
        rpc_error = copy.deepcopy(load("access_keys.json"))
        rpc_error["response"] = {"jsonrpc": "2.0", "id": "1", "error": {"code": -32000}}
        bad_account = copy.deepcopy(load("access_keys.json"))
        bad_account["account_id"] = "Not An Account"
        surrogate = copy.deepcopy(load("commitment.json"))
        surrogate["chain"] = "\ud800"
        cases = [
            ("broken json", {"keys": "{bad"}),
            ("json that is not an object", {"keys": "[]"}),
            ("missing commitment field", {"commitment": commitment_without("vault")}),
            ("rpc error response", {"keys": rpc_error}),
            ("invalid account id", {"keys": bad_account}),
            ("keys is not a list", {"keys": with_keys(load("access_keys.json"), "x")}),
            ("lone surrogate in text", {"commitment": surrogate}),
            ("deeply nested json", {"commitment": "[" * 100000}),
        ]
        for label, fixtures in cases:
            with self.subTest(label):
                result = run_staged(**fixtures)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("Traceback", result.stderr)

    def test_verify_offline_runs_with_sockets_blocked(self):
        guard = (
            "import runpy, socket, sys\n"
            "def blocked(*a, **k):\n"
            "    raise AssertionError('network used in offline mode')\n"
            "socket.socket.connect = blocked\n"
            "socket.getaddrinfo = blocked\n"
            "sys.argv = ['verify.py']\n"
            f"runpy.run_path({str(ROOT / 'verify.py')!r}, run_name='__main__')\n"
        )
        result = subprocess.run([sys.executable, "-c", guard], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, GOLDEN.read_text(encoding="utf-8"))

    def test_verify_offline_imports_only_allowlisted_modules(self):
        tree = ast.parse((ROOT / "verify.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                names = []
            for name in names:
                self.assertIn(name.split(".")[0], ALLOWED_IMPORTS, name)
            if isinstance(node, ast.Name):
                self.assertNotIn(node.id, {"__import__", "importlib", "eval", "exec"}, node.id)


if __name__ == "__main__":
    unittest.main()
