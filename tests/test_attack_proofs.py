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


class CommittedProofsTest(unittest.TestCase):
    """With FOUNDLING_PROOF_DIR set (make attack-proofs) the run must be able to say which commit it describes."""

    BUILT = NEW - 500  # a commit made before the WASM was built (the WASM's mtime is NEW)

    def setUp(self):
        RunRecordsSourceCommitTest.setUp(self)
        self.proof_path = self.root / "proofs" / "attack" / "reproducible" / "over-cap.json"
        self.proof_path.parent.mkdir(parents=True)

    def commit(self, when, message="one"):
        env = {**os.environ, "GIT_AUTHOR_DATE": f"@{when} +0000", "GIT_COMMITTER_DATE": f"@{when} +0000"}
        subprocess.run(["git", "-C", str(self.root), "add", "-A"], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(self.root), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message],
            check=True, capture_output=True, env=env,
        )

    def repository(self, when=None):
        git(self.root, "init", "-q")
        (self.root / ".gitignore").write_text("target/\nproofs/attack/reproducible/\n")
        self.commit(self.BUILT if when is None else when)

    def run_attack(self):
        env = {"FAKE_LOG": str(self.root / "cargo.json"), "FAKE_RC": "0", "FAKE_PROOF_PATH": str(self.proof_path),
               "FAKE_PROOF": proof("held"), "FOUNDLING_PROOF_DIR": str(self.proof_path.parent)}
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

    def test_a_clean_tree_at_a_commit_older_than_the_wasm_is_recorded(self):
        self.repository()
        self.assertEqual(self.run_attack(), 0)
        self.assertEqual(json.loads(self.proof_path.read_text())["source_commit"], git(self.root, "rev-parse", "HEAD"))

    def test_without_a_commit_the_run_is_refused_and_no_proof_is_written(self):
        self.assertEqual(self.run_attack(), 2)
        self.assertFalse(self.proof_path.exists())

    def test_a_dirty_tree_is_refused(self):
        self.repository()
        edited = self.root / "contracts" / "vault" / "src" / "lib.rs"
        edited.write_text("// edited after the commit\n")
        os.utime(edited, (OLD, OLD))  # so only the dirty tree, not a stale WASM, can refuse the run
        self.assertEqual(self.run_attack(), 2)
        self.assertFalse(self.proof_path.exists())

    def test_an_untracked_file_outside_the_proof_folder_is_refused(self):
        self.repository()
        (self.root / "stray.rs").write_text("")
        self.assertEqual(self.run_attack(), 2)

    def test_proofs_written_by_earlier_attacks_do_not_make_the_tree_dirty(self):
        self.repository()
        (self.proof_path.parent / "drip.json").write_text("{}\n")
        self.assertEqual(self.run_attack(), 0)

    def test_a_commit_newer_than_the_wasm_is_refused(self):
        self.repository(when=NEW + 500)
        self.assertEqual(self.run_attack(), 2)
        self.assertFalse(self.proof_path.exists())

    def test_a_local_run_still_allows_a_dirty_tree_and_no_commit(self):
        self.proof_path = self.root / "proofs" / "attack" / "local" / "over-cap.json"
        edited = self.root / "contracts" / "vault" / "src" / "lib.rs"
        edited.write_text("// not a repository at all\n")
        os.utime(edited, (OLD, OLD))
        self.assertEqual(RunRecordsSourceCommitTest.run_attack(self), 0)
        self.assertIsNone(json.loads(self.proof_path.read_text())["source_commit"])


if __name__ == "__main__":
    unittest.main()
