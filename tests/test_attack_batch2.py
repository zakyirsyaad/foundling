import json
import os
import re
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
            self.assertRegex(source, rf'Run::new\(\s*"{name}"')


def vault_panic_codes():
    """Every upper-case code the vault panics with: the literals inside require!(...) and
    panic_str(...) calls, and the upper-case &str consts of the sources (policy.rs hands two of them to
    panic_str; the rest are other reason codes, which SPEC 3.7 lists too)."""
    codes = {}
    for source in sorted((ROOT / "contracts" / "vault" / "src").glob("*.rs")):
        text = re.sub(r"(?m)^\s*//.*$", "", source.read_text())
        for opener in ("require!(", "panic_str("):
            start = 0
            while (at := text.find(opener, start)) >= 0:
                depth, end = 1, at + len(opener)
                while depth and end < len(text):
                    depth += {"(": 1, ")": -1}.get(text[end], 0)
                    end += 1
                for code in re.findall(r'"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"', text[at:end]):
                    codes.setdefault(code, source.name)
                start = end
        for code in re.findall(r"""(?m)^\s*(?:pub )?const [A-Z_]+: &(?:'static )?str = "([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)";""", text):
            codes.setdefault(code, source.name)
    return codes


class SpecReasonCodesTest(unittest.TestCase):
    def test_every_code_the_vault_panics_with_is_in_spec_3_7(self):
        # SPEC 3.7 calls itself the one canonical list, so a code the vault adds must be added there.
        section = (ROOT / "docs" / "SPEC.md").read_text().split("### 3.7", 1)[1].split("\n### ", 1)[0]
        codes = vault_panic_codes()
        self.assertGreater(len(codes), 20, codes)
        missing = {code: file for code, file in codes.items() if f"`{code}`" not in section}
        self.assertEqual(missing, {}, "panic codes missing from SPEC 3.7")

    def test_the_scanner_finds_the_codes_it_is_meant_to(self):
        codes = vault_panic_codes()
        for code in ("NOT_KEEPER", "LOW_GAS", "NOT_EXPIRED", "NOT_STALE", "POLICY_NOT_TIGHTER", "TIMELOCK", "PARAMS_TOO_LONG"):
            self.assertIn(code, codes)


class CiAndBuildTest(unittest.TestCase):
    def test_a_successful_wasm_build_touches_the_wasm_so_a_warm_cache_is_not_stale(self):
        # actions/cache restores target/ with old mtimes while checkout gives the sources new ones;
        # _sandbox.py compares the two, so make wasm has to be what makes the wasm current.
        for target in ("wasm", "attack-proofs"):
            plan = dry_run(target)
            self.assertIn("touch target/near/*.wasm", plan, target)
            self.assertLess(plan.index("cargo near build"), plan.index("touch target/near/*.wasm"), target)

    @staticmethod
    def soft_run_script():
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        step = workflow.split("      - name: Run every core attack\n        run: |\n", 1)[1]
        lines = []
        for line in step.splitlines():
            if line.startswith("          ") or line == "":
                lines.append(line[10:])
            else:
                break
        return "\n".join(lines)

    def run_soft_step(self, table, code):
        """Runs the soft job's step under `bash -e`, as GitHub does without `shell:`, with a fake
        run-all that prints `table` and exits `code`."""
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "fake-run-all"
            fake.write_text(f"#!/bin/sh\ncat <<'EOF'\n{table}\nEOF\nexit {code}\n")
            fake.chmod(0o755)
            script = self.soft_run_script()
            self.assertIn("python3 tools/attack.py run-all", script)
            script = script.replace("python3 tools/attack.py run-all", str(fake))
            path = Path(tmp) / "step.sh"
            path.write_text(script)
            env = {**os.environ, "RUNNER_TEMP": tmp, "GITHUB_STEP_SUMMARY": str(Path(tmp) / "summary.md")}
            return subprocess.run(["bash", "-e", str(path)], capture_output=True, text=True, env=env)

    def test_the_soft_step_exits_with_what_run_all_exits(self):
        # Without pipefail, `run-all | tee ... || status=$?` records tee's status and the step is always 0.
        result = self.run_soft_step("over-cap PASS\nPASS=1 FAIL=1 NOT_IMPLEMENTED=0 ERROR=0", 1)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_the_soft_step_fails_loudly_when_attacks_end_in_error(self):
        result = self.run_soft_step("PASS=0 FAIL=0 NOT_IMPLEMENTED=5 ERROR=10", 2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("::error::run-all reported ERROR", result.stdout)
        # Even if run-all itself had exited 0 with ERROR in its table, the step must not.
        self.assertNotEqual(self.run_soft_step("PASS=3 FAIL=0 NOT_IMPLEMENTED=0 ERROR=2", 0).returncode, 0)

    def test_the_soft_step_fails_when_no_attack_ran_at_all(self):
        result = self.run_soft_step("PASS=0 FAIL=0 NOT_IMPLEMENTED=15 ERROR=0", 0)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ran no attack", result.stdout)

    def test_the_soft_step_stays_green_on_a_clean_run(self):
        result = self.run_soft_step("PASS=10 FAIL=0 NOT_IMPLEMENTED=5 ERROR=0", 0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("::error::", result.stdout)


if __name__ == "__main__":
    unittest.main()
