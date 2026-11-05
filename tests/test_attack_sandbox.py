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

OLD, NEW = 1_700_000_000, 1_700_001_000

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


def proof(verdict, name="over-cap", expected=("OVER_CAP",), observed=("OVER_CAP",)):
    return json.dumps(
        {
            "attack": name,
            "verdict": verdict,
            "expected_codes": list(expected),
            "observed_codes": list(observed),
        }
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
        self.sources = []
        for directory, file in WASM:
            crate = self.root / "contracts" / directory
            for source in (crate / "src" / "lib.rs", crate / "Cargo.toml", crate / "Cargo.lock"):
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("")
                os.utime(source, (OLD, OLD))
                self.sources.append(source)
            wasm = crate / "target" / "near" / f"{file}.wasm"
            wasm.parent.mkdir(parents=True)
            wasm.write_bytes(b"\0asm")
            os.utime(wasm, (NEW, NEW))
        self.cargo = self.root / "cargo"
        self.cargo.write_text(FAKE_CARGO)
        self.cargo.chmod(self.cargo.stat().st_mode | stat.S_IXUSR)
        self.log = self.root / "cargo.json"
        self.proof_path = self.root / "proofs" / "attack" / "local" / "over-cap.json"

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

    def test_a_code_outside_the_expected_ones_is_a_breach_even_when_the_test_held(self):
        # The per-step booleans decide `held`; the codes are checked on top of them.
        stray = proof("held", observed=("OVER_CAP", "NOT_READY"))
        self.assertEqual(self.run_attack(0, stray), 1)

    def test_a_breach_is_reported_when_the_code_is_wrong_and_the_test_also_failed(self):
        self.assertEqual(self.run_attack(101, proof("held", observed=("MALFORMED",))), 1)

    def test_a_proof_without_observed_codes_exits_2(self):
        bare = json.dumps({"attack": "over-cap", "verdict": "held", "expected_codes": ["OVER_CAP"]})
        self.assertEqual(self.run_attack(0, bare), 2)

    def test_a_proof_with_codes_inside_the_expected_ones_still_passes(self):
        self.assertEqual(self.run_attack(0, proof("held", observed=())), 0)

    def test_a_proof_dir_from_the_environment_replaces_the_local_one(self):
        elsewhere = self.root / "committed"
        self.proof_path = elsewhere / "over-cap.json"
        os.environ["FOUNDLING_PROOF_DIR"] = str(elsewhere)
        self.addCleanup(os.environ.pop, "FOUNDLING_PROOF_DIR", None)
        self.assertEqual(self.run_attack(0, proof("held")), 0)

    def test_a_wasm_older_than_its_sources_exits_2_without_calling_cargo(self):
        for source in self.sources:
            with self.subTest(source=source.relative_to(self.root)):
                self.log.unlink(missing_ok=True)
                os.utime(source, (NEW + 1, NEW + 1))
                self.assertEqual(self.run_attack(0, proof("held")), 2)
                self.assertFalse(self.log.exists(), "cargo must not run on a stale wasm")
                os.utime(source, (OLD, OLD))

    def test_a_wasm_newer_than_its_sources_runs(self):
        self.assertEqual(self.run_attack(0, proof("held")), 0)

    def test_cargo_runs_the_exact_test_named_after_the_attack_in_sandbox(self):
        self.run_attack(0, proof("held"))
        call = json.loads(self.log.read_text())
        self.assertEqual(
            call["argv"],
            [
                "test", "--locked", "--test", "attacks_batch1", "over_cap",
                "--", "--exact",
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
