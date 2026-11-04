import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def dry_run(target):
    result = subprocess.run(
        ["make", "-n", target], capture_output=True, text=True, cwd=ROOT
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


class AttackLabMakeTest(unittest.TestCase):
    def test_attack_lab_needs_no_toolchain(self):
        # The CI scaffold job has Python only, and tests.test_attack_lab runs this target.
        plan = dry_run("attack-lab")
        self.assertNotIn("cargo", plan)
        self.assertIn("tools/attack.py run-all", plan)

    def test_attack_lab_full_builds_wasm_and_tests_before_the_clock_starts(self):
        plan = dry_run("attack-lab-full")
        build = plan.index("cargo near build")
        compile_tests = plan.index("--no-run")
        run_all = plan.index("tools/attack.py run-all")
        self.assertLess(build, compile_tests)
        self.assertLess(compile_tests, run_all)

    def test_attack_lab_full_runs_a_sandbox_test_first_so_neard_is_downloaded_outside_the_limit(self):
        plan = dry_run("attack-lab-full")
        warm = plan.index("--exact")
        self.assertLess(plan.index("--no-run"), warm)
        self.assertLess(warm, plan.index("tools/attack.py run-all"))

    def test_attack_lab_full_builds_every_contract_the_sandbox_deploys(self):
        loop = dry_run("attack-lab-full").split("; do", 1)[0]
        for contract in ("vault", "mock-oracle", "mock-ref", "mock-outlayer", "mock-token"):
            self.assertIn(contract, loop.split())

    def test_attack_lab_full_is_not_strict(self):
        self.assertNotIn("--strict", dry_run("attack-lab-full"))


if __name__ == "__main__":
    unittest.main()
