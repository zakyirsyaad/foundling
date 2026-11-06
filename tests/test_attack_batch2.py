import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
ATTACKS = ROOT / "tools" / "attacks"
sys.path.insert(0, str(ATTACKS))

import _sandbox  # noqa: E402

BATCH1 = ["over-cap", "drip", "replay", "bad-route", "stale-price"]
BATCH2 = ["kill-agent", "governor-loosen", "double-redeem", "forged-caller", "freeze-race"]
WASM = [
    ("vault", "foundling_vault"),
    ("mock-oracle", "mock_oracle"),
    ("mock-ref", "mock_ref"),
    ("mock-outlayer", "mock_outlayer"),
    ("mock-token", "mock_token"),
]


def dry_run(target):
    result = subprocess.run(["make", "-n", target], capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stderr
    return result.stdout


def registry():
    return json.loads((ROOT / "tools" / "attack-registry.json").read_text())["attacks"]


class BatchRoutingTest(unittest.TestCase):
    def test_the_registry_names_the_test_binary_of_every_scripted_attack_and_the_binary_has_the_test(self):
        # A missed entry sends an attack to a binary where --exact matches nothing: no proof, ERROR.
        for attack in registry():
            name = attack["name"]
            if not (ATTACKS / name).is_file():
                continue
            binary = attack.get("test_binary")
            self.assertIsNotNone(binary, f"{name} has a script but no test_binary in the registry")
            source = (ROOT / "sandbox" / "tests" / f"{binary}.rs").read_text()
            self.assertIn(f"async fn {name.replace('-', '_')}()", source, name)

    def test_batch2_attacks_use_the_batch2_test_binary_and_batch1_keeps_its_own(self):
        for name in BATCH2:
            self.assertEqual(_sandbox.test_binary(name), "attacks_batch2", name)
        for name in BATCH1:
            self.assertEqual(_sandbox.test_binary(name), "attacks_batch1", name)

    def test_an_entry_without_the_field_keeps_the_batch1_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "tools").mkdir()
            (Path(tmp) / "tools" / "attack-registry.json").write_text(
                json.dumps({"attacks": [{"name": "over-cap", "codes": []}]})
            )
            self.assertEqual(_sandbox.test_binary("over-cap", tmp), "attacks_batch1")

    def test_the_batches_do_not_overlap_and_both_are_in_the_registry(self):
        names = {a["name"] for a in registry()}
        self.assertFalse(set(BATCH1) & set(BATCH2))
        self.assertTrue(set(BATCH1 + BATCH2) <= names)

    def test_not_allowed_is_gone_from_the_spec_reason_codes_and_the_registry(self):
        # The lead's decision on PR 43: the vault never emits it.
        section = (ROOT / "docs" / "SPEC.md").read_text().split("### 3.7", 1)[1].split("\n### ", 1)[0]
        self.assertNotIn("NOT_ALLOWED", section)
        for attack in registry():
            self.assertNotIn("NOT_ALLOWED", json.dumps(attack), attack["name"])

    def test_cargo_is_asked_for_the_exact_batch2_test_named_after_the_attack(self):
        for name in BATCH2:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "sandbox").mkdir()
                (root / "tools").mkdir()
                (root / "tools" / "attack-registry.json").write_text(
                    json.dumps({"attacks": [{"name": name, "codes": [], "test_binary": "attacks_batch2"}]})
                )
                for directory, file in WASM:
                    crate = root / "contracts" / directory
                    (crate / "src").mkdir(parents=True)
                    source = crate / "src" / "lib.rs"
                    source.write_text("")
                    os.utime(source, (1_700_000_000, 1_700_000_000))
                    wasm = crate / "target" / "near" / f"{file}.wasm"
                    wasm.parent.mkdir(parents=True)
                    wasm.write_bytes(b"\0asm")
                    os.utime(wasm, (1_700_001_000, 1_700_001_000))
                calls = []

                def fake_run(command, **kwargs):
                    calls.append((command, kwargs["cwd"]))
                    return subprocess.CompletedProcess(command, 101)

                with mock.patch.object(_sandbox.subprocess, "run", fake_run):
                    code = _sandbox.run(name, root=root, cargo=["cargo"])
                self.assertEqual(code, 2, "no proof was written, so it is a tool error")
                self.assertEqual(
                    calls,
                    [(["cargo", "test", "--locked", "--test", "attacks_batch2",
                       name.replace("-", "_"), "--", "--exact"], root / "sandbox")],
                )


class BatchMakeTest(unittest.TestCase):
    def test_batch2_tests_are_compiled_before_the_attack_clock_starts(self):
        for target in ("attack-lab-full", "attack-proofs"):
            with self.subTest(target=target):
                plan = dry_run(target)
                compile_batch2 = plan.index("--test attacks_batch2 --no-run")
                self.assertLess(plan.index("--test attacks_batch1 --no-run"), compile_batch2)
                self.assertLess(compile_batch2, plan.index("tools/attack.py run-all"))


class BatchScriptsTest(unittest.TestCase):
    def test_each_batch2_attack_has_an_executable_launcher_that_names_itself(self):
        for name in BATCH2:
            script = ATTACKS / name
            self.assertTrue(script.is_file(), name)
            self.assertTrue(os.access(script, os.X_OK), f"{name} is not executable")
            text = script.read_text()
            self.assertTrue(text.startswith("#!/usr/bin/env python3"), name)
            self.assertIn(f'main("{name}")', text)

    def test_a_launcher_whose_runner_crashes_exits_2_not_1(self):
        # An uncaught exception exits 1, which the dispatcher would report as FAIL: attack succeeded.
        for crash in ("raise ImportError('boom')", "def main(name):\n    raise PermissionError('proof')"):
            with tempfile.TemporaryDirectory() as tmp:
                for name in BATCH2:
                    launcher = Path(tmp) / name
                    launcher.write_text((ATTACKS / name).read_text())
                    launcher.chmod(0o755)
                (Path(tmp) / "_sandbox.py").write_text(crash + "\n")
                for name in BATCH2:
                    result = subprocess.run([str(Path(tmp) / name)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2, (name, crash, result.stderr))
                    self.assertIn(name, result.stderr)

    def test_each_batch2_rust_test_is_named_after_its_attack(self):
        source = (ROOT / "sandbox" / "tests" / "attacks_batch2.rs").read_text()
        for name in BATCH2:
            self.assertIn(f"async fn {name.replace('-', '_')}()", source)
            self.assertIn(f'Run::new("{name}"', source)


if __name__ == "__main__":
    unittest.main()
