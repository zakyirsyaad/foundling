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


class BatchRoutingTest(unittest.TestCase):
    def test_batch2_attacks_use_the_batch2_test_binary_and_batch1_keeps_its_own(self):
        for name in BATCH2:
            self.assertEqual(_sandbox.test_binary(name), "attacks_batch2", name)
        for name in BATCH1:
            self.assertEqual(_sandbox.test_binary(name), "attacks_batch1", name)

    def test_the_batches_do_not_overlap_and_both_are_in_the_registry(self):
        registry = {
            a["name"] for a in json.loads((ROOT / "tools" / "attack-registry.json").read_text())["attacks"]
        }
        self.assertFalse(set(BATCH1) & set(BATCH2))
        self.assertTrue(set(BATCH1 + BATCH2) <= registry)
        self.assertEqual(set(_sandbox.BATCH2), set(BATCH2))

    def test_cargo_is_asked_for_the_exact_batch2_test_named_after_the_attack(self):
        for name in BATCH2:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "sandbox").mkdir()
                (root / "tools").mkdir()
                (root / "tools" / "attack-registry.json").write_text(
                    json.dumps({"attacks": [{"name": name, "codes": []}]})
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


if __name__ == "__main__":
    unittest.main()
