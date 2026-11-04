"""Structural checks on .github/workflows/ci.yml. Standard library only.

`check(text)` returns the problems it finds. The real workflow must have none, and every
tampering in TamperingTest must produce at least one, so a weakened check fails here too.

What it guards: only the Attack Lab run may fail without failing the workflow, nothing
can turn a red result green, and no job can be skipped or disabled. Jobs outside
REQUIRED_JOBS may be added, renamed or changed freely. It cannot stop the same pull
request from editing this file, so changes to it need a human reviewer.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

RUNNER = "ubuntu-24.04"
SOFT_JOB = "attack-lab-run"
PROMOTION_NOTE = "# diangkat jadi wajib (hapus continue-on-error) setelah T7-T9 selesai"
# Jobs whose removal would silently weaken the pipeline. Deleting one needs a deliberate
# edit of this list.
REQUIRED_JOBS = {
    "strategy", "contract", "verifier", "offline-verifier", "attack-lab", "keeper",
    "vault-wasm", "sandbox", "web", "dependencies", "secrets", SOFT_JOB, "workflow",
}
# Patterns that make a failing command succeed. `|| status=$?` is fine: it records the
# status and the step still fails on it.
ALWAYS_GREEN = (
    r"\|\|\s*(true|:|echo|exit\s+0)(\s|;|$)",
    r";\s*(true|:)\s*$",
    r"\bexit\s+0\b",
    r"\bset\s+\+e\b",
    r"--exit-zero",
)


def split_workflow(text):
    head, _, body = text.partition("\njobs:\n")
    header_count = len(re.findall(r"(?m)^  (?!#)\S", body))
    parts = re.split(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", body)
    return head, dict(zip(parts[1::2], parts[2::2])), header_count


def top_block(head, key):
    match = re.search(rf"(?m)^  {key}:[^\n]*\n((?:    .*\n|[ \t]*\n)*)", head + "\n")
    return match.group(1) if match else None


def check(text):
    problems = []
    head, jobs, header_count = split_workflow(text)
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))

    if header_count != len(jobs):
        problems.append("a job header is not a plain `  name:` line, so it was merged into the previous job")

    pull_request = top_block(head, "pull_request")
    filters = [l for l in (pull_request or "").splitlines() if l.strip() and not l.lstrip().startswith("#")]
    if pull_request is None or filters:
        problems.append("pull_request must be listed with no filters")
    push = top_block(head, "push")
    if push is None or not re.search(r"(?m)^    branches: \[main\]\s*$", push):
        problems.append("push must run on main")
    if not re.search(r"(?m)^permissions:\n  contents: read\s*$", head):
        problems.append("the token must be read-only (permissions: contents: read)")

    for name in sorted(REQUIRED_JOBS - set(jobs)):
        problems.append(f"required job missing: {name}")

    for name, body in jobs.items():
        runner = re.search(r"(?m)^    runs-on: (\$\{\{ matrix\.os \}\}|[^\s#]+)\s*(?:#.*)?$", body)
        if not runner:
            problems.append(f"{name}: no runs-on")
        elif runner.group(1) == "${{ matrix.os }}":
            matrix = re.search(r"(?m)^        os: \[(.+?)\]\s*$", body)
            entries = matrix.group(1).split(",") if matrix else []
            if not entries or not all(re.fullmatch(r"ubuntu-\d\d\.\d\d", e.strip()) for e in entries):
                problems.append(f"{name}: matrix.os must list only ubuntu runners")
        elif runner.group(1) != RUNNER:
            problems.append(f"{name}: runs-on is {runner.group(1)}, expected {RUNNER}")
        if not re.search(r"(?m)^    timeout-minutes: \d+\s*$", body):
            problems.append(f"{name}: no timeout-minutes")
        if re.search(r"(?m)^    permissions:", body):
            problems.append(f"{name}: job-level permissions are not allowed")

    for ref in re.findall(r"(?m)^\s*-?\s*uses: (\S+)", code):
        if not re.search(r"@[0-9a-f]{40}$", ref):
            problems.append(f"action not pinned to a full commit: {ref}")

    if re.search(r"(?m)^\s*(?:-\s*)?if:", code):
        problems.append("`if:` can skip a job or step; none is allowed")

    for pattern in ALWAYS_GREEN:
        if re.search(pattern, code, re.M):
            problems.append(f"can turn a failure green: /{pattern}/")

    flagged = [l for l in code.splitlines() if "continue-on-error" in l]
    if len(flagged) != 1:
        problems.append(f"continue-on-error must appear exactly once, found {len(flagged)}")
    soft = jobs.get(SOFT_JOB, "")
    lines = soft.splitlines()
    if "    continue-on-error: true" not in lines:
        problems.append(f"{SOFT_JOB} must carry `    continue-on-error: true`")
    elif lines[lines.index("    continue-on-error: true") - 1].strip() != PROMOTION_NOTE:
        problems.append("the promotion note must sit directly above continue-on-error")
    if not re.search(r"python3 tools/attack\.py run-all\b", soft):
        problems.append(f"{SOFT_JOB} must run `python3 tools/attack.py run-all`")
    if 'exit "$status"' not in soft:
        problems.append(f'{SOFT_JOB} must end with exit "$status" so a failure stays visible')

    def runs(job, pattern):
        if not re.search(rf"(?m)^\s+run: {pattern}\s*$", jobs.get(job, "")):
            problems.append(f"{job}: expected a step `run: {pattern}`")

    runs("attack-lab", r"python3 -m unittest tests\.test_attack_lab")
    runs("offline-verifier", r"python3 verify\.py")
    runs("sandbox", r"make sandbox")
    runs("workflow", r"python3 -m unittest tests\.test_ci_workflow")

    wasm = jobs.get("vault-wasm", "")
    build = wasm.find("cargo near build non-reproducible-wasm")
    audit = wasm.find("python3 tools/wasm_imports.py contracts/vault/target/near/foundling_vault.wasm tools/allowlist.txt")
    if build < 0 or audit < 0 or build > audit:
        problems.append("vault-wasm must build the WASM and then audit that same file")
    return problems


def tampered(base, old, new):
    assert old in base, f"tampering does not apply: {old!r}"
    return base.replace(old, new, 1)


class RealWorkflowTest(unittest.TestCase):
    def test_the_real_workflow_has_no_problems(self):
        self.assertEqual(check(WORKFLOW.read_text(encoding="utf-8")), [])


class TamperingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = WORKFLOW.read_text(encoding="utf-8")

    def test_each_tampering_is_caught(self):
        b = self.base
        sha = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"
        attack_lab = "  attack-lab:\n    name: Attack Lab scaffold\n"
        sandbox = "  sandbox:\n    name: Sandbox\n"
        workflow = "  workflow:\n    name: Workflow shape\n"
        cases = {
            "verify.py || true": tampered(b, "run: python3 verify.py\n", "run: python3 verify.py || true\n"),
            "|| : after a command": tampered(b, "run: make sandbox\n", "run: make sandbox || :\n"),
            "|| echo ok": tampered(b, "run: make sandbox\n", "run: make sandbox || echo ok\n"),
            "; true": tampered(b, "run: make sandbox\n", "run: make sandbox; true\n"),
            "exit 0 in a step": tampered(b, "run: make sandbox\n", "run: make sandbox; exit 0\n"),
            "set +e": tampered(b, "run: make sandbox\n", "run: set +e; make sandbox\n"),
            "job disabled with if: false": tampered(b, attack_lab, attack_lab + "    if: false\n"),
            "job disabled with an expression": tampered(b, workflow, workflow + "    if: ${{ false }}\n"),
            "step if: always()": tampered(b, "      - name: Check that no job", "      - if: always()\n        name: Check that no job"),
            "continue-on-error on sandbox": tampered(b, sandbox, sandbox + "    continue-on-error: true\n"),
            "continue-on-error on a step": tampered(b, "      - name: Run every core attack\n", "      - name: Run every core attack\n        continue-on-error: true\n"),
            "continue-on-error quoted": tampered(b, sandbox, sandbox + '    "continue-on-error": true\n'),
            "continue-on-error with a space": tampered(b, sandbox, sandbox + "    continue-on-error : true\n"),
            "continue-on-error on attack-lab": tampered(b, attack_lab, attack_lab + "    continue-on-error: true\n"),
            "promotion note removed": tampered(b, PROMOTION_NOTE, "# todo"),
            "promotion note moved": tampered(b, f"    {PROMOTION_NOTE}\n    continue-on-error: true\n", "    continue-on-error: true\n    # note\n"),
            "attack-lab command replaced": tampered(b, "run: python3 -m unittest tests.test_attack_lab\n", "run: 'true'\n"),
            "workflow command only echoed": tampered(b, "run: python3 -m unittest tests.test_ci_workflow\n", "run: echo python3 -m unittest tests.test_ci_workflow\n"),
            "run-all replaced": tampered(b, "python3 tools/attack.py run-all", "echo skip"),
            "soft job swallows the status": tampered(b, 'exit "$status"', "true"),
            "action pinned to a tag": tampered(b, sha, "actions/checkout@v4"),
            "no timeout": tampered(b, workflow + "    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n", workflow + "    runs-on: ubuntu-24.04\n"),
            "macos runner": tampered(b, workflow + "    runs-on: ubuntu-24.04", workflow + "    runs-on: macos-latest"),
            "job-level write permission": tampered(b, workflow, workflow + "    permissions: write-all\n"),
            "audit replaced": tampered(b, "python3 tools/wasm_imports.py contracts", "echo skip contracts"),
            "required job deleted": b[: b.index("\n  web:\n")] + b[b.index("\n  dependencies:\n"):],
            "pull_request narrowed": tampered(b, "  pull_request:\n", "  pull_request:\n    paths: ['docs/**']\n"),
            "push no longer on main": tampered(b, "    branches: [main]", "    branches: [nothing]"),
            "token made writable": tampered(b, "  contents: read", "  contents: write"),
            "job header with a comment": b + "\n  evil: # sneaky\n    runs-on: macos-latest\n    steps: [{run: 'true'}]\n",
            "flow-style job": b + "\n  evil: {runs-on: macos-latest, steps: []}\n",
        }
        for name, text in cases.items():
            with self.subTest(tampering=name):
                self.assertTrue(check(text), "the tampering was not caught")

    def test_comments_that_mention_forbidden_words_are_fine(self):
        text = tampered(self.base, "      - name: Run every core attack\n", "      # not exit 0 and not || true\n      - name: Run every core attack\n")
        self.assertEqual(check(text), [])


if __name__ == "__main__":
    unittest.main()
