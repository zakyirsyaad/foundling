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


def recipe_line(plan, index):
    """The whole line of `make -n` output that holds `plan[index]`, however long the checkout path makes it."""
    start = plan.rfind("\n", 0, index) + 1
    end = plan.find("\n", index)
    return plan[start : len(plan) if end < 0 else end]


class RecipeLineTest(unittest.TestCase):
    def test_a_long_checkout_path_does_not_push_the_variable_out_of_view(self):
        root = "/" + "very-long-directory/" * 20 + "foundling"
        command = f"FOUNDLING_PROOF_DIR={root}/proofs/attack/reproducible python3 tools/attack.py run-all"
        plan = "cd sandbox && cargo test\n" + command + "\n"
        line = recipe_line(plan, plan.index("tools/attack.py run-all"))
        self.assertEqual(line, command)
        self.assertGreater(plan.index("tools/attack.py run-all") - plan.index("FOUNDLING_PROOF_DIR="), 140)

    def test_the_line_stops_at_the_previous_and_the_next_recipe_line(self):
        plan = "first\nsecond tools/attack.py run-all\nthird"
        self.assertEqual(recipe_line(plan, plan.index("tools/")), "second tools/attack.py run-all")
        self.assertEqual(recipe_line("only tools/attack.py run-all", 5), "only tools/attack.py run-all")


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


    def test_attack_proofs_builds_the_vault_reproducibly_and_writes_the_committed_proofs(self):
        plan = dry_run("attack-proofs")
        reproducible = plan.index("cargo near build reproducible-wasm")
        run_all = plan.index("tools/attack.py run-all")
        self.assertLess(reproducible, run_all)
        line = recipe_line(plan, run_all)
        self.assertIn("FOUNDLING_PROOF_DIR=", line)
        # Not proofs/attack/<name>.json: web/lib/proof/sample.ts reads those as results, and the
        # web test of the lead expects every attack there to be "Not run yet".
        self.assertIn("proofs/attack/reproducible", line)
        # The mocks are built the usual way; only the vault is the audited artifact.
        loop = plan.split("; do", 1)[0]
        self.assertNotIn("vault", loop.split())
        for mock in ("mock-oracle", "mock-ref", "mock-outlayer", "mock-token"):
            self.assertIn(mock, loop.split())

if __name__ == "__main__":
    unittest.main()
