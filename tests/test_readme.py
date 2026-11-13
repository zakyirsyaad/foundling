"""README.md is built by tools/readme.py from claims.json; these tests keep it honest and in step."""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

README = (ROOT / "README.md").read_text(encoding="utf-8")
CLAIMS = json.loads((ROOT / "claims.json").read_text(encoding="utf-8"))
GOLDEN = (ROOT / "proofs" / "expected" / "verify-offline.txt").read_text(encoding="utf-8")
SPEC = (ROOT / "docs" / "SPEC.md").read_text(encoding="utf-8")


def head(text):
    """The part before the first `## ` heading: what a reader or a screening tool sees first."""
    return text.split("\n## ", 1)[0]


def first_not_pass(claims):
    """Only a claim that is not `pass` puts its downgrade text in the README, so drift is tested on one of those."""
    return next(claim for claim in claims if claim["status"] != "pass")


def run_tool(*args):
    return subprocess.run([sys.executable, str(ROOT / "tools" / "readme.py"), *args],
                          capture_output=True, text=True, cwd=ROOT)


class Workspace(unittest.TestCase):
    """A copy of the three inputs, so a test can change one and leave the repository alone."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name)
        self.claims = self.path / "claims.json"
        self.template = self.path / "template.md"
        self.golden = self.path / "golden.txt"
        self.out = self.path / "README.md"
        shutil.copy(ROOT / "claims.json", self.claims)
        shutil.copy(ROOT / "tools" / "readme_template.md", self.template)
        shutil.copy(ROOT / "proofs" / "expected" / "verify-offline.txt", self.golden)

    def tool(self, *extra):
        return run_tool("--claims", str(self.claims), "--template", str(self.template),
                        "--golden", str(self.golden), "--out", str(self.out), "--root", str(ROOT), *extra)

    def edit_claims(self, change):
        data = json.loads(self.claims.read_text(encoding="utf-8"))
        change(data)
        self.claims.write_text(json.dumps(data), encoding="utf-8")


class DriftTest(Workspace):
    def test_the_committed_readme_is_what_the_generator_builds(self):
        done = run_tool("--check")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_changing_claims_json_without_regenerating_fails_the_check(self):
        self.assertEqual(self.tool().returncode, 0)
        self.assertEqual(self.tool("--check").returncode, 0)
        self.edit_claims(lambda claims: first_not_pass(claims).update(downgrade="A changed downgrade text."))
        done = self.tool("--check")
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("make readme", done.stderr + done.stdout)

    def test_a_hand_edit_of_the_readme_fails_the_check(self):
        self.tool()
        self.out.write_text(self.out.read_text() + "\nA claim nobody checked.\n", encoding="utf-8")
        self.assertEqual(self.tool("--check").returncode, 1)

    def test_regenerating_after_the_change_passes_again(self):
        self.tool()
        self.edit_claims(lambda claims: first_not_pass(claims).update(downgrade="A different sentence."))
        self.assertEqual(self.tool("--check").returncode, 1)
        self.assertEqual(self.tool().returncode, 0)
        self.assertEqual(self.tool("--check").returncode, 0)

    def test_the_check_does_not_write_the_readme(self):
        self.assertEqual(self.tool("--check").returncode, 1, "no README yet")
        self.assertFalse(self.out.exists())

    def test_make_readme_runs_the_generator(self):
        plan = subprocess.run(["make", "-n", "readme"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertIn("python3 tools/readme.py", plan.stdout)


class ClaimsTest(Workspace):
    def test_only_pass_claims_are_in_the_table_and_the_rest_are_listed_as_not_proven(self):
        table = [line for line in README.splitlines() if line.startswith("| ") and "claims.json" not in line]
        for claim in CLAIMS:
            in_table = any(claim["claim"] in line for line in table)
            self.assertEqual(in_table, claim["status"] == "pass", claim["id"])
        proven = README.split("\n## Not proven yet", 1)[1].split("\n## ", 1)[0]
        for claim in CLAIMS:
            if claim["status"] != "pass":
                self.assertIn(claim["downgrade"], proven, claim["id"])
                self.assertIn(f"`{claim['id']}`", proven)
            else:
                self.assertNotIn(f"`{claim['id']}`", proven)

    def test_every_pass_row_carries_evidence_a_command_and_a_status(self):
        for claim in CLAIMS:
            if claim["status"] != "pass":
                continue
            row = next(line for line in README.splitlines() if line.startswith("| ") and claim["claim"] in line)
            self.assertIn("pass", row)
            for check in claim["checks"]:
                self.assertIn(check["cmd"].replace("|", "\\|"), row)
            refs = claim["evidence"] or claim["test_refs"]
            self.assertTrue(refs, f"{claim['id']} has neither evidence nor tests")
            for ref in refs:
                self.assertIn(ref, row)

    def test_a_row_says_where_its_command_runs(self):
        row = next(line for line in README.splitlines() if "redeem" in line and "cargo test" in line)
        self.assertIn("offline", row)
        live = next(line for line in README.splitlines() if "fetch_proof.py" in line and line.startswith("| "))
        self.assertIn("live", live)

    def test_a_status_that_is_not_pass_skip_or_fail_is_a_tool_error(self):
        self.edit_claims(lambda claims: claims[0].update(status="maybe"))
        done = self.tool()
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertFalse(self.out.exists())

    def test_more_than_twelve_claims_is_a_tool_error(self):
        self.edit_claims(lambda claims: claims.extend({**claims[0], "id": f"extra-{n}"} for n in range(6)))
        self.assertEqual(self.tool().returncode, 2)

    def test_a_pass_claim_without_evidence_or_tests_is_a_tool_error(self):
        bare = next(c for c in CLAIMS if c["status"] == "skip" and not (c["evidence"] or c["test_refs"]))
        self.edit_claims(lambda claims: next(c for c in claims if c["id"] == bare["id"]).update(status="pass"))
        done = self.tool()
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn("neither evidence nor tests", done.stderr)

    def test_a_pass_claim_that_names_a_missing_file_is_a_tool_error(self):
        passing = next(c for c in CLAIMS if c["status"] == "pass" and c["evidence"])
        self.edit_claims(lambda claims: next(c for c in claims if c["id"] == passing["id"])["evidence"].append("no/such/file.json"))
        self.assertEqual(self.tool().returncode, 2)

    def test_a_claim_without_a_downgrade_text_is_a_tool_error(self):
        self.edit_claims(lambda claims: claims[0].pop("downgrade"))
        self.assertEqual(self.tool().returncode, 2)

    def test_duplicate_ids_are_a_tool_error(self):
        self.edit_claims(lambda claims: claims[1].update(id=claims[0]["id"]))
        self.assertEqual(self.tool().returncode, 2)

    def test_a_skip_claim_turned_pass_moves_into_the_table(self):
        skipped = next(c for c in CLAIMS if c["status"] == "skip" and c["checks"] and (c["evidence"] or c["test_refs"]))
        self.edit_claims(lambda claims: next(c for c in claims if c["id"] == skipped["id"]).update(status="pass"))
        self.assertEqual(self.tool().returncode, 0)
        text = self.out.read_text(encoding="utf-8")
        self.assertTrue(any(line.startswith("| ") and skipped["claim"] in line for line in text.splitlines()))
        self.assertNotIn(skipped["downgrade"], text)


class FirstScreenTest(unittest.TestCase):
    def test_the_first_screen_has_what_the_spec_asks_for_within_25_lines_plus_the_table_rows(self):
        passing = sum(c["status"] == "pass" for c in CLAIMS)
        top = head(README)
        self.assertLessEqual(len(top.splitlines()), 21 + passing, "tagline, what, problem, verify, table, diagram, video, try")
        for needle in ("python3 verify.py", "claims.json", "make attack-lab", "Video", "Try to rob it"):
            self.assertIn(needle, top)

    def test_the_verify_line_is_copied_from_the_golden_file_not_written_by_hand(self):
        last = GOLDEN.strip().splitlines()[-1]
        self.assertIn(last, head(README))
        self.assertIn("synthetic", head(README))

    def test_the_four_boxes_are_drawn(self):
        top = head(README)
        for box in ("[Depositor]", "[Vault contract]", "[Keeper bot]", "[OutLayer TEE"):
            self.assertIn(box, top)

    def test_the_video_is_not_claimed_before_it_exists(self):
        self.assertFalse((ROOT / "docs" / "video").exists(), "update the README when the video lands")
        self.assertIn("not recorded yet", head(README))


class DisclosureTest(unittest.TestCase):
    def test_the_disclaimer_says_demo_unaudited_and_not_an_invitation_to_deposit(self):
        text = README.lower()
        for needle in ("technical demo", "not been audited by a third party", "not an invitation to deposit"):
            self.assertIn(needle, text)

    def test_the_role_text_is_the_one_in_the_spec(self):
        quote = SPEC.split("**Teks peran di README (Inggris).**", 1)[1]
        quote = next(line[2:] for line in quote.splitlines() if line.startswith("> **Who holds which key.**"))
        self.assertIn(quote, README)

    def test_provenance_names_the_baseline_the_ai_help_and_the_libraries(self):
        section = README.split("\n## Provenance", 1)[1].split("\n## ", 1)[0]
        for needle in ("2026-11-01", "baseline", "Claude-Session", "THIRD_PARTY_NOTICES.md", "spikes/sp1a"):
            self.assertIn(needle, section)

    def test_the_trust_table_names_who_still_has_to_be_trusted(self):
        section = README.split("\n## What you still have to trust", 1)[1].split("\n## ", 1)[0]
        for needle in ("OutLayer", "NEAR AI", "Rhea", "oracle", "USDC", "lead", "guardian"):
            self.assertIn(needle, section)

    def test_no_partner_logo_and_no_deposit_pitch(self):
        self.assertNotRegex(README, r"!\[[^\]]*\]\(")
        for word in ("guaranteed", "risk-free", "earn ", "yield", "apy"):
            self.assertNotIn(word, README.lower())


def git_ignored(path):
    """True when .gitignore covers `path`, like the local Attack Lab output the README names.

    Such a folder exists only after a local run, so a fresh checkout (CI) never has it.
    """
    return subprocess.run(["git", "check-ignore", "-q", path], cwd=ROOT, check=False).returncode == 0


def missing_repo_paths(text):
    """Relative links and repo paths in `text` that are neither on disk nor git-ignored, sorted."""
    top_level = {p.name for p in ROOT.iterdir() if not p.name.startswith(".")}
    candidates = [t for t in re.findall(r"\]\(([^)#\s]+)(?:#[^)]*)?\)", text) if not re.match(r"[a-z]+://", t)]
    for token in re.findall(r"`([^`\s|]+)`", text):
        first = token.split("/", 1)[0]
        looks_like_path = "/" in token and first in top_level or token in top_level
        if looks_like_path and not re.search(r"[<>*{}]", token):
            candidates.append(token)
    return sorted({p for p in candidates if not (ROOT / p).exists() and not git_ignored(p)})


class LinkTest(unittest.TestCase):
    def test_every_relative_link_and_every_repo_path_in_the_readme_exists(self):
        self.assertEqual(missing_repo_paths(README), [])

    def test_only_a_git_ignored_output_path_may_be_absent(self):
        text = "Results go to `proofs/attack/local/`; see `docs/no-such.md`, `proofs/no-such/` and [x](tools/no_such.py)."
        self.assertEqual(missing_repo_paths(text), ["docs/no-such.md", "proofs/no-such/", "tools/no_such.py"])

    def test_every_path_a_claim_names_exists(self):
        missing = [ref for claim in CLAIMS for key in ("evidence", "code_refs", "test_refs")
                   for ref in claim[key] if not (ROOT / ref).exists()]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
