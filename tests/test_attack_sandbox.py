import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTACKS = ROOT / "tools" / "attacks"
sys.path.insert(0, str(ATTACKS))

import _sandbox  # noqa: E402

BATCH1 = ["over-cap", "drip", "replay", "bad-route", "stale-price"]
WASM = [
    ("vault", "foundling_vault"),
    ("mock-oracle", "mock_oracle"),
    ("mock-ref", "mock_ref"),
    ("mock-outlayer", "mock_outlayer"),
    ("mock-token", "mock_token"),
]

# Stands in for cargo: records how it was called, then writes the proof FAKE_PROOF
# names (if any) and exits FAKE_RC.
FAKE_CARGO = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path(os.environ["FAKE_LOG"]).write_text(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}))
if os.environ.get("FAKE_PROOF"):
    target = Path(os.environ["FAKE_PROOF_PATH"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(os.environ["FAKE_PROOF"])
sys.exit(int(os.environ.get("FAKE_RC", "0")))
"""


def proof(verdict, name="over-cap", expected=("OVER_CAP",)):
    return json.dumps(
        {"attack": name, "verdict": verdict, "expected_codes": list(expected), "observed": []}
    )


class SandboxRunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "sandbox").mkdir()
        (self.root / "tools").mkdir()
        (self.root / "tools" / "attack-registry.json").write_text(
            json.dumps({"attacks": [{"name": "over-cap", "codes": ["OVER_CAP"]}]})
        )
        for directory, file in WASM:
            wasm = self.root / "contracts" / directory / "target" / "near" / f"{file}.wasm"
            wasm.parent.mkdir(parents=True)
            wasm.write_bytes(b"\0asm")
        self.cargo = self.root / "cargo"
        self.cargo.write_text(FAKE_CARGO)
        self.cargo.chmod(self.cargo.stat().st_mode | stat.S_IXUSR)
        self.log = self.root / "cargo.json"
        self.proof_path = self.root / "proofs" / "attack" / "over-cap.json"

    def run_attack(self, rc=0, written=None, name="over-cap"):
        env = {"FAKE_LOG": str(self.log), "FAKE_RC": str(rc),
               "FAKE_PROOF_PATH": str(self.proof_path)}
        if written is not None:
            env["FAKE_PROOF"] = written
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            return _sandbox.run(name, root=self.root, cargo=[str(self.cargo)])
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_held_verdict_with_a_passing_test_exits_0(self):
        self.assertEqual(self.run_attack(0, proof("held")), 0)

    def test_breached_verdict_exits_1_even_though_cargo_failed(self):
        self.assertEqual(self.run_attack(101, proof("breached")), 1)

    def test_no_proof_exits_2_because_the_test_never_reached_a_verdict(self):
        self.assertEqual(self.run_attack(101), 2)

    def test_a_proof_with_a_clean_run_but_no_verdict_is_not_a_pass(self):
        self.assertEqual(self.run_attack(0, json.dumps({"attack": "over-cap"})), 2)

    def test_held_proof_but_failing_cargo_is_a_tool_error_not_a_pass(self):
        self.assertEqual(self.run_attack(101, proof("held")), 2)

    def test_a_proof_left_by_an_earlier_run_is_not_reused(self):
        self.proof_path.parent.mkdir(parents=True)
        self.proof_path.write_text(proof("held"))
        self.assertEqual(self.run_attack(0), 2)

    def test_a_proof_that_is_not_json_exits_2(self):
        self.assertEqual(self.run_attack(0, "not json"), 2)

    def test_a_proof_for_another_attack_exits_2(self):
        self.assertEqual(self.run_attack(0, proof("held", name="drip")), 2)

    def test_expected_codes_must_match_the_registry(self):
        self.assertEqual(self.run_attack(0, proof("held", expected=("OVER_EPOCH_CAP",))), 2)

    def test_missing_wasm_exits_2_without_calling_cargo(self):
        (self.root / "contracts" / "vault" / "target" / "near" / "foundling_vault.wasm").unlink()
        self.assertEqual(self.run_attack(0, proof("held")), 2)
        self.assertFalse(self.log.exists(), "cargo must not run without the wasm")

    def test_missing_cargo_exits_2(self):
        self.cargo.unlink()
        self.assertEqual(self.run_attack(0, proof("held")), 2)

    def test_cargo_runs_the_exact_test_named_after_the_attack_in_sandbox(self):
        self.run_attack(0, proof("held"))
        call = json.loads(self.log.read_text())
        self.assertEqual(
            call["argv"],
            [
                "test", "--locked", "--test", "attacks_batch1", "over_cap",
                "--", "--exact", "--include-ignored",
            ],
        )
        self.assertEqual(Path(call["cwd"]).resolve(), (self.root / "sandbox").resolve())


class BatchScriptsTest(unittest.TestCase):
    def test_each_batch1_attack_has_an_executable_script_that_names_itself(self):
        registry = {
            a["name"] for a in json.loads((ROOT / "tools" / "attack-registry.json").read_text())["attacks"]
        }
        for name in BATCH1:
            script = ATTACKS / name
            self.assertTrue(script.is_file(), name)
            self.assertTrue(os.access(script, os.X_OK), f"{name} is not executable")
            text = script.read_text()
            self.assertTrue(text.startswith("#!/usr/bin/env python3"), name)
            self.assertIn(f'main("{name}")', text)
            self.assertIn(name, registry)


    def test_a_launcher_whose_runner_crashes_exits_2_not_1(self):
        # An uncaught exception exits 1, which the dispatcher would report as FAIL: attack succeeded.
        for crash in ("raise ImportError('boom')", "def main(name):\n    raise PermissionError('proof')"):
            with tempfile.TemporaryDirectory() as tmp:
                for name in BATCH1:
                    launcher = Path(tmp) / name
                    launcher.write_text((ATTACKS / name).read_text())
                    launcher.chmod(0o755)
                (Path(tmp) / "_sandbox.py").write_text(crash + "\n")
                for name in BATCH1:
                    result = subprocess.run([str(Path(tmp) / name)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2, (name, crash, result.stderr))
                    self.assertIn(name, result.stderr)


if __name__ == "__main__":
    unittest.main()
