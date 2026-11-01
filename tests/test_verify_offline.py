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


def load(name):
    return json.loads((PROOFS / name).read_text())


def run_cli(*args, proofs=PROOFS):
    return subprocess.run(
        [sys.executable, str(ROOT / "verify.py"), "--proofs", str(proofs), *args],
        capture_output=True,
        text=True,
    )


def proofs_dir(tmp, commitment=None, keys=None):
    out = Path(tmp)
    (out / "commitment.json").write_text(json.dumps(commitment or load("commitment.json")))
    (out / "access_keys.json").write_text(json.dumps(keys or load("access_keys.json")))
    return out


class VerifyOffline(unittest.TestCase):
    def test_verify_commitment_check_pass_on_good_fixture(self):
        result = verify.check_commitment(load("commitment.json"))
        self.assertEqual(result.status, "PASS")

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

    def test_verify_keys_check_fails_if_keys_nonempty(self):
        keys = copy.deepcopy(load("access_keys.json"))
        keys["keys"] = [{"public_key": "ed25519:AAAA", "access_key": {"permission": "FullAccess"}}]
        result = verify.check_keys(keys)
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.reason, "KEYS_NONEMPTY")

    def test_verify_offline_output_matches_golden_snapshot(self):
        result = run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, GOLDEN.read_text())

    def test_verify_exit_code_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = copy.deepcopy(load("commitment.json"))
            bad["salt"] = "00" * 32
            tampered = proofs_dir(tmp, commitment=bad)
            for sub in ([], ["commitment"], ["keys"]):
                self.assertEqual(run_cli(*sub).returncode, 0, sub)
            self.assertEqual(run_cli("commitment", proofs=tampered).returncode, 1)
            self.assertEqual(run_cli(proofs=tampered).returncode, 1)
            self.assertEqual(run_cli("keys", proofs=tampered).returncode, 0)

        with tempfile.TemporaryDirectory() as empty:
            for sub in ([], ["commitment"], ["keys"]):
                self.assertEqual(run_cli(*sub, proofs=empty).returncode, 2, sub)
        self.assertEqual(run_cli("no-such-subcommand").returncode, 2)

    def test_verify_offline_path_imports_no_network_modules(self):
        tree = ast.parse((ROOT / "verify.py").read_text())
        banned = {"urllib", "requests", "socket", "http", "ssl"}
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                self.assertNotIn(name.split(".")[0], banned, name)


if __name__ == "__main__":
    unittest.main()
