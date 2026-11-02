import json
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTACK_PY = ROOT / "tools" / "attack.py"
FOUNDLING = ROOT / "tools" / "foundling"
REGISTRY = ROOT / "tools" / "attack-registry.json"
SPEC = ROOT / "docs" / "SPEC.md"
STATUSES = "PASS|FAIL|NOT_IMPLEMENTED|ERROR"

CORE_ATTACKS = [
    "over-cap",
    "drip",
    "replay",
    "bad-route",
    "stale-price",
    "kill-agent",
    "governor-loosen",
    "double-redeem",
    "forged-caller",
    "freeze-race",
    "inflated-nav",
    "deflated-sell",
    "never-flat",
    "setup-spam",
    "advance-race",
]


def run(*args, attacks_dir=None, registry=None, flags=()):
    cmd = [sys.executable, str(ATTACK_PY), *flags]
    if registry:
        cmd += ["--registry", str(registry)]
    if attacks_dir:
        cmd += ["--attacks-dir", str(attacks_dir)]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)


def load_registry():
    return json.loads(REGISTRY.read_text())["attacks"]


def make_script(directory, name, exit_code, body=None):
    path = Path(directory) / f"{name}.sh"
    path.write_text(body or f"#!/bin/sh\necho fake {name}\nexit {exit_code}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def write_registry(path, names):
    entries = [{"name": n, "expected": f"`{n}`", "codes": []} for n in names]
    Path(path).write_text(json.dumps({"attacks": entries}))
    return path


class AttackLabTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.attacks = self.tmp / "attacks"
        self.attacks.mkdir()

    def registry_of(self, names):
        return write_registry(self.tmp / "r.json", names)

    def test_registry_has_all_core_attacks(self):
        names = [a["name"] for a in load_registry()]
        self.assertEqual(len(names), len(set(names)), "ada nama ganda di registry")
        missing = [n for n in CORE_ATTACKS if n not in names]
        self.assertEqual(missing, [], f"serangan inti hilang: {missing}")

    def test_attack_list_prints_the_15_core_names(self):
        result = subprocess.run(
            [str(FOUNDLING), "attack", "list"], capture_output=True, text=True, cwd=ROOT
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), CORE_ATTACKS)

    def test_registry_expected_matches_spec_verbatim(self):
        rows = {}
        for line in SPEC.read_text().splitlines():
            m = re.match(r"\| `attack ([a-z-]+)` \| .* \| (.*) \|$", line)
            if m:
                rows[m.group(1)] = m.group(2)
        for attack in load_registry():
            self.assertEqual(attack["expected"], rows[attack["name"]], attack["name"])

    def test_registry_codes_exist_in_spec_reason_code_list(self):
        section = SPEC.read_text().split("### 3.7", 1)[1].split("\n### ", 1)[0]
        for attack in load_registry():
            for code in attack["codes"]:
                pattern = rf"`{re.escape(code)}`|`{re.escape(code)}\{{"
                self.assertRegex(section, pattern, (attack["name"], code))

    def test_dispatcher_unimplemented_exits_2(self):
        result = run("run", "over-cap", attacks_dir=self.attacks)
        self.assertEqual(result.returncode, 2)
        self.assertIn("NOT_IMPLEMENTED: over-cap", result.stderr)

    def test_dispatcher_unknown_attack_exits_2(self):
        result = run("run", "no-such-attack")
        self.assertEqual(result.returncode, 2)
        self.assertIn("UNKNOWN_ATTACK: no-such-attack", result.stderr)

    def test_summary_counts_pass_fail_correctly(self):
        make_script(self.attacks, "alpha", 0)
        make_script(self.attacks, "beta", 1)
        make_script(self.attacks, "delta", 2)
        registry = self.registry_of(["alpha", "beta", "gamma", "delta"])

        result = run("run-all", attacks_dir=self.attacks, registry=registry)

        lines = result.stdout.splitlines()
        self.assertTrue(any(re.fullmatch(r"alpha\s+PASS", l) for l in lines), result.stdout)
        self.assertTrue(any(re.fullmatch(r"beta\s+FAIL", l) for l in lines), result.stdout)
        self.assertTrue(
            any(re.fullmatch(r"gamma\s+NOT_IMPLEMENTED", l) for l in lines), result.stdout
        )
        self.assertTrue(any(re.fullmatch(r"delta\s+ERROR", l) for l in lines), result.stdout)
        self.assertIn("PASS=1 FAIL=1 NOT_IMPLEMENTED=1 ERROR=1", result.stdout)
        self.assertEqual(result.returncode, 1)

    def test_non_executable_script_is_error_not_unimplemented(self):
        (self.attacks / "over-cap.sh").write_text("#!/bin/sh\nexit 0\n")
        result = run("run", "over-cap", attacks_dir=self.attacks)
        self.assertEqual(result.returncode, 2)
        self.assertIn("NOT_EXECUTABLE", result.stderr)
        self.assertNotIn("NOT_IMPLEMENTED", result.stderr)

    def test_run_normalizes_script_exit_codes_to_0_1_2(self):
        registry = self.registry_of(["seven"])
        make_script(self.attacks, "seven", 7)
        result = run("run", "seven", attacks_dir=self.attacks, registry=registry)
        self.assertEqual(result.returncode, 2)

    def test_signal_killed_script_is_error(self):
        registry = self.registry_of(["killed"])
        make_script(self.attacks, "killed", 0, body="#!/bin/sh\nkill -9 $$\n")
        result = run("run-all", attacks_dir=self.attacks, registry=registry)
        self.assertIn("ERROR=1", result.stdout)
        self.assertEqual(result.returncode, 2)

    def test_hung_script_times_out_as_error_naming_the_attack(self):
        registry = self.registry_of(["slow"])
        make_script(self.attacks, "slow", 0, body="#!/bin/sh\nexec sleep 30\n")
        result = run(
            "run-all", attacks_dir=self.attacks, registry=registry, flags=("--timeout", "1")
        )
        self.assertIn("TIMEOUT: slow", result.stderr)
        self.assertRegex(result.stdout, r"(?m)^slow\s+ERROR$")
        self.assertEqual(result.returncode, 2)

    def test_missing_registry_exits_2_not_1(self):
        result = run("run-all", registry=self.tmp / "nope.json")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("BAD_REGISTRY", result.stderr)

    def test_empty_registry_exits_2(self):
        registry = self.tmp / "r.json"
        registry.write_text('{"attacks": []}')
        result = run("run-all", registry=registry)
        self.assertEqual(result.returncode, 2)
        self.assertIn("BAD_REGISTRY", result.stderr)

    def test_duplicate_registry_names_exit_2(self):
        result = run("run-all", registry=self.registry_of(["a", "a"]))
        self.assertEqual(result.returncode, 2)
        self.assertIn("BAD_REGISTRY", result.stderr)

    def test_registry_name_that_is_not_a_string_exits_2(self):
        registry = self.tmp / "r.json"
        registry.write_text('{"attacks": [{"name": 5}]}')
        result = run("run-all", registry=registry)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("BAD_REGISTRY", result.stderr)

    def test_registry_name_cannot_escape_the_attacks_dir(self):
        make_script(self.tmp, "evil", 0, body="#!/bin/sh\ntouch ran-outside\nexit 0\n")
        for bad in ["../evil", "Evil", "a b", "", "-x", "a/b"]:
            with self.subTest(name=bad):
                result = run(
                    "run-all", attacks_dir=self.attacks, registry=self.registry_of([bad])
                )
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("BAD_REGISTRY", result.stderr)
        self.assertFalse((ROOT / "ran-outside").exists())
        self.assertFalse((self.tmp / "ran-outside").exists())

    def test_run_all_exits_0_when_nothing_fails(self):
        make_script(self.attacks, "alpha", 0)
        registry = self.registry_of(["alpha", "gamma"])
        result = run("run-all", attacks_dir=self.attacks, registry=registry)
        self.assertIn("PASS=1 FAIL=0 NOT_IMPLEMENTED=1 ERROR=0", result.stdout)
        self.assertEqual(result.returncode, 0)

    def test_strict_turns_not_implemented_into_exit_2(self):
        make_script(self.attacks, "alpha", 0)
        registry = self.registry_of(["alpha", "gamma"])
        result = run(
            "run-all", attacks_dir=self.attacks, registry=registry, flags=("--strict",)
        )
        self.assertIn("NOT_IMPLEMENTED=1", result.stdout)
        self.assertEqual(result.returncode, 2)

    def test_strict_exits_0_when_every_attack_passes(self):
        make_script(self.attacks, "alpha", 0)
        registry = self.registry_of(["alpha"])
        result = run(
            "run-all", attacks_dir=self.attacks, registry=registry, flags=("--strict",)
        )
        self.assertEqual(result.returncode, 0)

    def test_strict_still_reports_fail_as_1(self):
        make_script(self.attacks, "beta", 1)
        registry = self.registry_of(["beta", "gamma"])
        result = run(
            "run-all", attacks_dir=self.attacks, registry=registry, flags=("--strict",)
        )
        self.assertEqual(result.returncode, 1)

    def test_make_attack_lab_reports_every_core_attack_with_a_status(self):
        result = subprocess.run(
            ["make", "-s", "attack-lab"], capture_output=True, text=True, cwd=ROOT
        )
        self.assertIn(result.returncode, (0, 1, 2), result.stderr)
        for name in CORE_ATTACKS:
            self.assertRegex(result.stdout, rf"(?m)^{name}\s+({STATUSES})$")
        counts = re.search(
            r"PASS=(\d+) FAIL=(\d+) NOT_IMPLEMENTED=(\d+) ERROR=(\d+)", result.stdout
        )
        self.assertIsNotNone(counts, result.stdout)
        self.assertEqual(sum(int(c) for c in counts.groups()), len(CORE_ATTACKS))


if __name__ == "__main__":
    unittest.main()
