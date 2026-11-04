"""Structural checks on .github/workflows/ci.yml. Standard library only.

They guard the shape of the pipeline: that only the Attack Lab run may fail without
failing the workflow, and that no step can turn a red result green. They do not pin the
full job list, so adding or renaming other jobs never needs a change here.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

RUNNER = "ubuntu-24.04"
JOBS_THAT_MUST_EXIST = {"offline-verifier", "attack-lab", "attack-lab-run", "vault-wasm", "sandbox", "secrets", "workflow"}
SOFT_JOB = "attack-lab-run"
PROMOTION_NOTE = "# diangkat jadi wajib (hapus continue-on-error) setelah T7-T9 selesai"
ALWAYS_GREEN = (
    re.compile(r"\|\|\s*true\b"),
    re.compile(r"\bexit\s+0\b"),
    re.compile(r"\bset\s+\+e\b"),
    re.compile(r"if:\s*(\$\{\{\s*)?always\(\)"),
)


def load_jobs(text):
    head, _, body = text.partition("\njobs:\n")
    parts = re.split(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", body)
    return head, dict(zip(parts[1::2], parts[2::2]))


class CiWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.head, cls.jobs = load_jobs(cls.text)

    def test_runs_on_every_pull_request_and_main(self):
        self.assertRegex(self.head, r"(?m)^  pull_request:\s*$")
        self.assertRegex(self.head, r"(?m)^    branches: \[main\]\s*$")

    def test_token_is_read_only(self):
        self.assertRegex(self.head, r"(?m)^permissions:\n  contents: read\s*$")

    def test_the_jobs_this_pipeline_relies_on_exist(self):
        missing = JOBS_THAT_MUST_EXIST - set(self.jobs)
        self.assertFalse(missing, f"missing jobs: {sorted(missing)}")

    def test_every_job_runs_on_an_ubuntu_amd64_runner(self):
        for name, body in self.jobs.items():
            with self.subTest(job=name):
                match = re.search(r"(?m)^    runs-on: (.+?)\s*$", body)
                self.assertIsNotNone(match)
                runner = match.group(1)
                if runner == "${{ matrix.os }}":
                    matrix = re.search(r"(?m)^        os: \[(.+?)\]\s*$", body)
                    self.assertIsNotNone(matrix)
                    for entry in matrix.group(1).split(","):
                        self.assertRegex(entry.strip(), r"^ubuntu-\d\d\.\d\d$")
                else:
                    self.assertEqual(runner, RUNNER)

    def test_the_jobs_this_pipeline_builds_with_run_on_the_canonical_runner(self):
        for name in ("vault-wasm", "sandbox", "attack-lab-run"):
            with self.subTest(job=name):
                if name in self.jobs:
                    self.assertRegex(self.jobs[name], rf"(?m)^    runs-on: {re.escape(RUNNER)}\s*$")

    def test_every_job_has_a_timeout(self):
        for name, body in self.jobs.items():
            with self.subTest(job=name):
                self.assertRegex(body, r"(?m)^    timeout-minutes: \d+\s*$")

    def test_every_action_is_pinned_to_a_full_commit(self):
        uses = re.findall(r"(?m)^\s*-?\s*uses: (\S+)", self.text)
        self.assertTrue(uses)
        for ref in uses:
            with self.subTest(uses=ref):
                self.assertRegex(ref, r"@[0-9a-f]{40}$")

    def test_only_the_attack_lab_run_may_fail_without_failing_the_workflow(self):
        for name, body in self.jobs.items():
            with self.subTest(job=name):
                found = re.search(r"(?m)^    continue-on-error:", body) is not None
                self.assertEqual(found, name == SOFT_JOB)
        self.assertEqual(len(re.findall(r"(?m)^\s*continue-on-error:", self.text)), 1)

    def test_the_soft_job_is_explicitly_true(self):
        self.assertRegex(self.jobs[SOFT_JOB], r"(?m)^    continue-on-error: true\s*$")

    def test_the_soft_job_carries_the_promotion_note_directly_above(self):
        lines = self.jobs[SOFT_JOB].splitlines()
        index = lines.index("    continue-on-error: true")
        self.assertEqual(lines[index - 1].strip(), PROMOTION_NOTE)

    def test_the_attack_lab_unit_tests_can_fail_the_workflow(self):
        self.assertNotIn("continue-on-error", self.jobs["attack-lab"])

    def test_nothing_can_turn_a_failure_green(self):
        for pattern in ALWAYS_GREEN:
            with self.subTest(pattern=pattern.pattern):
                self.assertIsNone(pattern.search(self.text))

    def test_the_soft_job_runs_every_core_attack(self):
        self.assertRegex(self.jobs[SOFT_JOB], r"(?m)^\s+run: python3 tools/attack\.py run-all\s*$")

    def test_vault_wasm_builds_then_audits_that_wasm(self):
        body = self.jobs["vault-wasm"]
        build = body.index("cargo near build non-reproducible-wasm")
        audit = body.index(
            "python3 tools/wasm_imports.py contracts/vault/target/near/foundling_vault.wasm tools/allowlist.txt"
        )
        self.assertLess(build, audit)

    def test_the_offline_verifier_runs_the_verifier(self):
        self.assertRegex(self.jobs["offline-verifier"], r"(?m)^\s+run: python3 verify\.py\s*$")

    def test_the_sandbox_job_runs_make_sandbox(self):
        self.assertRegex(self.jobs["sandbox"], r"(?m)^\s+run: make sandbox\s*$")

    def test_the_workflow_job_runs_this_file(self):
        self.assertIn("python3 -m unittest tests.test_ci_workflow", self.jobs["workflow"])


if __name__ == "__main__":
    unittest.main()
