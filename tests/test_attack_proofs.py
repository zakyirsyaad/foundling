import contextlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTACKS = ROOT / "tools" / "attacks"
sys.path.insert(0, str(ATTACKS))

import _sandbox  # noqa: E402
from tests.test_attack_sandbox import FAKE_CARGO, NEW, OLD, WASM, proof  # noqa: E402

HEX40 = re.compile(r"[0-9a-f]{40}")


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t", *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


class GitHeadTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

    def test_reads_the_commit_checked_out_in_the_root(self):
        git(self.root, "init", "-q")
        (self.root / "a").write_text("a")
        git(self.root, "add", "a")
        git(self.root, "commit", "-q", "-m", "one")
        self.assertEqual(_sandbox.git_head(self.root), git(self.root, "rev-parse", "HEAD"))

    def test_is_none_when_the_root_is_not_a_repository(self):
        self.assertIsNone(_sandbox.git_head(self.root))

    def test_is_none_for_a_folder_inside_somebody_elses_repository(self):
        git(self.root, "init", "-q")
        (self.root / "a").write_text("a")
        git(self.root, "add", "a")
        git(self.root, "commit", "-q", "-m", "one")
        inner = self.root / "inner"
        inner.mkdir()
        self.assertIsNone(_sandbox.git_head(inner))

    def test_is_none_in_a_repository_without_a_commit(self):
        git(self.root, "init", "-q")
        self.assertIsNone(_sandbox.git_head(self.root))


class RunRecordsSourceCommitTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        (self.root / "sandbox").mkdir()
        (self.root / "tools").mkdir()
        (self.root / "tools" / "attack-registry.json").write_text(
            json.dumps({"attacks": [{"name": "over-cap", "codes": ["OVER_CAP"]}]})
        )
        for directory, file in WASM:
            crate = self.root / "contracts" / directory
            for source in (crate / "src" / "lib.rs", crate / "Cargo.toml", crate / "Cargo.lock"):
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("")
                os.utime(source, (OLD, OLD))
            wasm = crate / "target" / "near" / f"{file}.wasm"
            wasm.parent.mkdir(parents=True)
            wasm.write_bytes(b"\0asm")
            os.utime(wasm, (NEW, NEW))
        self.cargo = self.root / "cargo"
        self.cargo.write_text(FAKE_CARGO)
        self.cargo.chmod(self.cargo.stat().st_mode | stat.S_IXUSR)
        self.proof_path = self.root / "proofs" / "attack" / "local" / "over-cap.json"

    def run_attack(self):
        env = {"FAKE_LOG": str(self.root / "cargo.json"), "FAKE_RC": "0",
               "FAKE_PROOF_PATH": str(self.proof_path), "FAKE_PROOF": proof("held")}
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            return _sandbox.run("over-cap", root=self.root, cargo=[str(self.cargo)])
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_a_held_proof_gets_the_commit_the_run_was_made_at(self):
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "one")
        head = git(self.root, "rev-parse", "HEAD")
        self.assertEqual(self.run_attack(), 0)
        recorded = json.loads(self.proof_path.read_text())
        self.assertEqual(recorded["source_commit"], head)
        self.assertRegex(recorded["source_commit"], HEX40)
        self.assertEqual(recorded["attack"], "over-cap", "the rest of the proof is kept")

    def test_outside_a_repository_the_field_is_null_and_the_run_still_passes(self):
        self.assertEqual(self.run_attack(), 0)
        self.assertIsNone(json.loads(self.proof_path.read_text())["source_commit"])

    def test_the_file_keeps_the_rust_writer_format(self):
        self.assertEqual(self.run_attack(), 0)
        text = self.proof_path.read_text()
        self.assertEqual(text, json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def snapshot(commit):
    """The metadata cargo-near embeds in a reproducible WASM (NEP-330), cut down to what the check reads."""
    return (b'{"version":"0.1.0","link":"https://github.com/o/r/tree/' + commit.encode() + b'","build_info":'
            b'{"source_code_snapshot":"git+https://github.com/o/r?rev=' + commit.encode() + b'"}}')


class CommittedProofsTest(unittest.TestCase):
    """With the proof dir at proofs/attack/reproducible (make attack-proofs) the run must be able to say
    which commit it describes: HEAD has to be the commit the vault WASM says it was built at."""

    OTHER = "1" * 40

    def setUp(self):
        RunRecordsSourceCommitTest.setUp(self)
        self.proof_path = self.root / "proofs" / "attack" / "reproducible" / "over-cap.json"
        self.proof_path.parent.mkdir(parents=True)
        self.vault_wasm = self.root / "contracts" / "vault" / "target" / "near" / "foundling_vault.wasm"

    def repository(self, embed=True):
        git(self.root, "init", "-q")
        (self.root / ".gitignore").write_text("target/\nproofs/attack/reproducible/\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "one")
        head = git(self.root, "rev-parse", "HEAD")
        if embed:
            self.build_at(head)
        return head

    def build_at(self, commit):
        self.vault_wasm.write_bytes(b"\0asm" + snapshot(commit) if commit else b"\0asm")
        os.utime(self.vault_wasm, (NEW, NEW))

    def run_attack(self, refused=False):
        """(exit code, stderr). stderr is captured only for a run that must be refused: cargo never starts
        then, and a captured sys.stderr cannot be handed to a child process."""
        env = {"FAKE_LOG": str(self.root / "cargo.json"), "FAKE_RC": "0", "FAKE_PROOF_PATH": str(self.proof_path),
               "FAKE_PROOF": proof("held"), "FOUNDLING_PROOF_DIR": str(self.proof_path.parent)}
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        err = io.StringIO()
        try:
            if refused:
                with contextlib.redirect_stderr(err):
                    code = _sandbox.run("over-cap", root=self.root, cargo=[str(self.cargo)])
            else:
                code = _sandbox.run("over-cap", root=self.root, cargo=[str(self.cargo)])
            return code, err.getvalue()
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_a_clean_tree_whose_wasm_was_built_at_head_is_recorded(self):
        head = self.repository()
        code, _ = self.run_attack()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.proof_path.read_text())["source_commit"], head)

    def test_a_wasm_built_at_another_commit_is_refused_whatever_the_dates_say(self):
        # The case an mtime check cannot see: an older (or any other) commit checked out after the build.
        self.repository(embed=False)
        self.build_at(self.OTHER)
        code, err = self.run_attack(refused=True)
        self.assertEqual(code, 2)
        self.assertIn("built at " + self.OTHER[:12], err)
        self.assertFalse(self.proof_path.exists())

    def test_a_wasm_that_carries_no_source_commit_is_refused(self):
        self.repository(embed=False)
        self.build_at(None)
        code, err = self.run_attack(refused=True)
        self.assertEqual(code, 2)
        self.assertIn("carries no source commit", err)
        self.assertFalse(self.proof_path.exists())

    def test_without_a_commit_the_run_is_refused_and_no_proof_is_written(self):
        code, err = self.run_attack(refused=True)
        self.assertEqual(code, 2)
        self.assertIn("no commit is checked out", err)
        self.assertFalse(self.proof_path.exists())

    def test_a_dirty_tree_is_refused(self):
        self.repository()
        edited = self.root / "contracts" / "vault" / "src" / "lib.rs"
        edited.write_text("// edited after the commit\n")
        os.utime(edited, (OLD, OLD))  # so only the dirty tree, not a stale WASM, can refuse the run
        code, err = self.run_attack(refused=True)
        self.assertEqual(code, 2)
        self.assertIn("uncommitted changes", err)
        self.assertFalse(self.proof_path.exists())

    def test_an_untracked_file_outside_the_proof_folder_is_refused(self):
        self.repository()
        (self.root / "stray.rs").write_text("")
        code, err = self.run_attack(refused=True)
        self.assertEqual(code, 2)
        self.assertIn("stray.rs", err)

    def test_proofs_written_by_earlier_attacks_do_not_make_the_tree_dirty(self):
        self.repository()
        (self.proof_path.parent / "drip.json").write_text("{}\n")
        code, _ = self.run_attack()
        self.assertEqual(code, 0)

    def test_a_local_run_still_allows_a_dirty_tree_and_no_commit(self):
        self.proof_path = self.root / "proofs" / "attack" / "local" / "over-cap.json"
        edited = self.root / "contracts" / "vault" / "src" / "lib.rs"
        edited.write_text("// not a repository at all\n")
        os.utime(edited, (OLD, OLD))
        self.assertEqual(RunRecordsSourceCommitTest.run_attack(self), 0)
        self.assertIsNone(json.loads(self.proof_path.read_text())["source_commit"])



class SourceDirtyTest(unittest.TestCase):
    """A local run says whether the tree it built from had uncommitted changes."""

    setUp = RunRecordsSourceCommitTest.setUp
    run_attack = RunRecordsSourceCommitTest.run_attack

    def commit_all(self):
        (self.root / ".gitignore").write_text("cargo.json\n")  # the fake cargo's own log
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "one")

    def recorded(self):
        return json.loads(self.proof_path.read_text())

    def test_a_clean_local_run_says_the_tree_was_clean(self):
        self.commit_all()
        self.assertEqual(self.run_attack(), 0)
        self.assertIs(self.recorded()["source_dirty"], False)

    def test_a_local_run_with_uncommitted_changes_says_so_beside_the_commit(self):
        self.commit_all()
        edited = self.root / "contracts" / "vault" / "src" / "lib.rs"
        edited.write_text("// edited, not committed\n")
        os.utime(edited, (OLD, OLD))
        self.assertEqual(self.run_attack(), 0)
        self.assertEqual(self.recorded()["source_commit"], git(self.root, "rev-parse", "HEAD"))
        self.assertIs(self.recorded()["source_dirty"], True)

    def test_outside_a_repository_it_is_null_like_the_commit(self):
        self.assertEqual(self.run_attack(), 0)
        self.assertIsNone(self.recorded()["source_dirty"])


if __name__ == "__main__":
    unittest.main()
