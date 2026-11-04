import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
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
    """flags (--strict, --timeout) go after the subcommand, the way people type them."""
    cmd = [sys.executable, str(ATTACK_PY)]
    if registry:
        cmd += ["--registry", str(registry)]
    if attacks_dir:
        cmd += ["--attacks-dir", str(attacks_dir)]
    cmd += [args[0], *flags, *args[1:]]
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

    def test_timeout_kills_the_whole_process_group(self):
        registry = self.registry_of(["spawner"])
        pidfile = self.tmp / "child.pid"
        make_script(
            self.attacks,
            "spawner",
            0,
            body=f"#!/bin/sh\nsleep 29 >/dev/null 2>&1 &\necho $! > {pidfile}\nwait\n",
        )
        run("run", "spawner", attacks_dir=self.attacks, registry=registry, flags=("--timeout", "1"))
        child = int(pidfile.read_text())
        self.addCleanup(self.kill_quietly, child)
        for _ in range(20):
            if not self.alive(child):
                break
            time.sleep(0.1)
        self.assertFalse(self.alive(child), "child of a timed-out attack is still running")

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    @staticmethod
    def kill_quietly(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def test_ctrl_c_kills_the_running_attack(self):
        registry = self.registry_of(["hang"])
        pidfile = self.tmp / "hang.pid"
        make_script(
            self.attacks, "hang", 0, body=f"#!/bin/sh\necho $$ > {pidfile}\nexec sleep 29\n"
        )
        proc = subprocess.Popen(
            [sys.executable, str(ATTACK_PY), "--registry", str(registry),
             "--attacks-dir", str(self.attacks), "run", "hang"],
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(proc.kill)
        for _ in range(50):
            if pidfile.exists() and pidfile.read_text().strip():
                break
            time.sleep(0.1)
        child = int(pidfile.read_text())
        self.addCleanup(self.kill_quietly, child)
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=10)
        for _ in range(20):
            if not self.alive(child):
                break
            time.sleep(0.1)
        self.assertFalse(self.alive(child), "attack kept running after Ctrl-C")

    def test_timeout_must_be_finite_and_positive(self):
        for bad in ["0", "-1", "nan", "inf", "abc"]:
            with self.subTest(timeout=bad):
                result = run("run-all", flags=("--timeout", bad))
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("argument --timeout", result.stderr)
                self.assertNotIn("unrecognized arguments", result.stderr)

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


# Runs the real dispatcher, but os.killpg first kills the group and then reports
# an error, the way it does when the group is already gone (ProcessLookupError)
# or is all zombies on macOS (PermissionError). The race cannot be hit reliably.
RACING_KILLPG_HARNESS = """
import os, sys
sys.path.insert(0, {tools!r})
import attack
real_killpg = os.killpg
def killpg(pgid, sig):
    real_killpg(pgid, sig)
    raise {error}("group already gone")
os.killpg = killpg
sys.exit(attack.main(sys.argv[1:]))
"""


class AttackCleanupTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.attacks = self.tmp / "attacks"
        self.attacks.mkdir()

    def registry_of(self, names):
        return write_registry(self.tmp / "r.json", names)

    def start(self, registry, *args, racing_error=None):
        argv = ["--registry", str(registry), "--attacks-dir", str(self.attacks), *args]
        if racing_error:
            harness = RACING_KILLPG_HARNESS.format(tools=str(ATTACK_PY.parent), error=racing_error)
            cmd = [sys.executable, "-c", harness, *argv]
        else:
            cmd = [sys.executable, str(ATTACK_PY), *argv]
        out = open(self.tmp / "out.txt", "w")
        err = open(self.tmp / "err.txt", "w")
        self.addCleanup(out.close)
        self.addCleanup(err.close)
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=out, stderr=err)
        self.addCleanup(proc.kill)
        return proc

    def finish(self, proc):
        proc.wait(timeout=10)
        return (self.tmp / "err.txt").read_text()

    def pid_from(self, pidfile):
        for _ in range(50):
            if pidfile.exists() and pidfile.read_text().strip():
                pid = int(pidfile.read_text())
                self.addCleanup(AttackLabTest.kill_quietly, pid)
                return pid
            time.sleep(0.1)
        self.fail(f"{pidfile.name} was never written")

    def assert_dies(self, pid, message):
        for _ in range(30):
            if not AttackLabTest.alive(pid):
                return
            time.sleep(0.1)
        self.fail(message)

    def make_hang(self, name="hang"):
        pidfile = self.tmp / f"{name}.pid"
        make_script(
            self.attacks, name, 0, body=f"#!/bin/sh\necho $$ > {pidfile}\nexec sleep 29\n"
        )
        return pidfile

    def test_timeout_is_reported_when_killpg_finds_the_group_gone(self):
        registry = self.registry_of(["slow"])
        self.make_hang("slow")
        for error in ("ProcessLookupError", "PermissionError"):
            with self.subTest(error=error):
                proc = self.start(registry, "run", "slow", "--timeout", "1", racing_error=error)
                stderr = self.finish(proc)
                self.assertIn("TIMEOUT: slow", stderr)
                self.assertNotIn("cannot run", stderr)

    def test_ctrl_c_is_not_swallowed_when_killpg_finds_the_group_gone(self):
        registry = self.registry_of(["hang", "after"])
        pidfile = self.make_hang()
        marker = self.tmp / "after.ran"
        make_script(self.attacks, "after", 0, body=f"#!/bin/sh\ntouch {marker}\nexit 0\n")
        for error in ("ProcessLookupError", "PermissionError"):
            with self.subTest(error=error):
                marker.unlink(missing_ok=True)
                pidfile.unlink(missing_ok=True)
                proc = self.start(registry, "run-all", racing_error=error)
                self.pid_from(pidfile)
                proc.send_signal(signal.SIGINT)
                stderr = self.finish(proc)
                self.assertNotIn("cannot run", stderr)
                self.assertFalse(marker.exists(), "run-all went on to the next attack after Ctrl-C")

    def test_child_left_behind_by_a_script_that_exits_0_is_killed(self):
        registry = self.registry_of(["leaver"])
        pidfile = self.tmp / "child.pid"
        make_script(
            self.attacks,
            "leaver",
            0,
            body=f"#!/bin/sh\nsleep 29 >/dev/null 2>&1 &\necho $! > {pidfile}\nexit 0\n",
        )
        proc = self.start(registry, "run", "leaver")
        self.finish(proc)
        self.assertEqual(proc.returncode, 0)
        child = self.pid_from(pidfile)
        self.assert_dies(child, "child of a script that exited 0 is still running")


if __name__ == "__main__":
    unittest.main()
