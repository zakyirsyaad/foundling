"""Runs one sandbox attack for tools/attack.py: `cargo test` in sandbox/, then the verdict.

The Rust test writes <proof dir>/<name>.json before it asserts, with `verdict` set to
"held" or "breached" and `result` set to the matching "PASS" or "FAIL", which the website
reads. The proof dir is $FOUNDLING_PROOF_DIR, else proofs/attack/local (ignored by git);
proofs/attack/reproducible holds the ones committed from a run on the reproducible build.
Exit codes follow the dispatcher: 0 held, 1 breached, 2 tool error. A breach is a verdict of
"breached", or any observed reason code outside the registry's codes for the attack. Without
a proof the test never reached a verdict (a build error, a missing or stale wasm, a failed
harness call), which is 2 and never a pass or a fail of the attack.
After a verdict, run() adds `source_commit` to the proof: the commit the repository was at, so the
vault_wasm_sha256 in a committed proof can be rebuilt from it. It is null outside a repository, but
when the proof dir is proofs/attack/reproducible (the committed ones, make attack-proofs) a missing commit,
a dirty tree, or a vault WASM that was not built at HEAD (the commit is read from the WASM's own
metadata) is exit 2 before anything runs.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEST_BINARY = "attacks_batch1"
WASM = [
    ("vault", "foundling_vault"),
    ("mock-oracle", "mock_oracle"),
    ("mock-ref", "mock_ref"),
    ("mock-outlayer", "mock_outlayer"),
    ("mock-token", "mock_token"),
]


def ask_git(root, *args):
    """stdout of `git -C root args`, or None when git is missing or the command fails."""
    try:
        done = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    except OSError:
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def git_head(root):
    """The commit checked out in `root` itself, or None (not a repository, no commit, or a folder inside another repository)."""
    root = Path(root).resolve()
    top, head = ask_git(root, "rev-parse", "--show-toplevel"), ask_git(root, "rev-parse", "HEAD")
    if top is None or Path(top).resolve() != root or head is None or not re.fullmatch(r"[0-9a-f]{40}", head):
        return None
    return head


SNAPSHOT = re.compile(rb'"source_code_snapshot":"git\+[^"?]*\?rev=([0-9a-f]{40})"')


def wasm_commit(wasm):
    """The commit `cargo near build` recorded inside the WASM (NEP-330 contract metadata), or None."""
    try:
        found = SNAPSHOT.search(Path(wasm).read_bytes())
    except OSError:
        return None
    return found.group(1).decode() if found else None


def tree_changes(root):
    """`git status --porcelain` of `root` (resolved) without the proof folder, which earlier attacks fill;
    "" for a clean tree, None when git cannot say."""
    spec = ["."]
    try:
        spec.append(f":(exclude){proof_dir(root).resolve().relative_to(root).as_posix()}")
    except ValueError:
        pass
    return ask_git(root, "status", "--porcelain", "--untracked-files=normal", "--", *spec)


def provenance_problem(root, wasm):
    """Why the commit checked out in `root` cannot stand for the build under test, or None.

    The reproducible build embeds the commit it was made at, so a committed proof is only worth keeping
    when HEAD is exactly that commit and the tree is clean (apart from the proof folder, which earlier
    attacks fill). The commit is read from the WASM itself: file dates and commit dates can be wrong
    after a checkout, a rebase or an amend, the embedded commit cannot.
    """
    root = Path(root).resolve()
    head = git_head(root)
    if head is None:
        return "no commit is checked out here, so source_commit would be null"
    dirty = tree_changes(root)
    if dirty is None:
        return "git status failed, so a clean tree cannot be confirmed"
    if dirty:
        return f"the working tree has uncommitted changes ({dirty.splitlines()[0].strip()}), so source_commit would not describe the build"
    built = wasm_commit(wasm)
    if built is None:
        return "the vault WASM carries no source commit, so it was not built by `cargo near build reproducible-wasm`"
    if built != head:
        return f"the vault WASM was built at {built[:12]} but HEAD is {head[:12]}"
    return None


def record_source_commit(proof_path, proof, root):
    """Rewrites the proof with `source_commit`, in the format the Rust writer uses (sorted keys, 2 spaces)."""
    head = git_head(root)
    proof["source_commit"] = head
    # A local run may build from uncommitted changes; say so, so the commit is not read as the build's
    # whole source. Committed proofs are refused on a dirty tree before they run, so there it is false.
    changes = None if head is None else tree_changes(Path(root).resolve())
    proof["source_dirty"] = None if changes is None else bool(changes)
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def registry_entry(root, name):
    attacks = json.loads((Path(root) / "tools" / "attack-registry.json").read_text())["attacks"]
    return next(a for a in attacks if a["name"] == name)


def test_binary(name, root=ROOT):
    """The cargo test binary that holds the attack, from the registry; batch 1 has no field."""
    return registry_entry(root, name).get("test_binary", TEST_BINARY)


def proof_dir(root):
    return Path(os.environ.get("FOUNDLING_PROOF_DIR") or Path(root) / "proofs" / "attack" / "local")


def newest_source(crate):
    """Latest change among the crate's sources, manifest and lockfile (0 when none exist)."""
    files = [*(crate / "src").rglob("*"), crate / "Cargo.toml", crate / "Cargo.lock"]
    return max((f.stat().st_mtime for f in files if f.is_file()), default=0)


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    return 2


def registry_codes(root, name):
    return registry_entry(root, name)["codes"]


def run(name, root=ROOT, cargo=("cargo",)):
    root = Path(root)
    missing, stale = [], []
    for directory, file in WASM:
        crate = root / "contracts" / directory
        wasm = crate / "target" / "near" / f"{file}.wasm"
        if not wasm.is_file():
            missing.append(f"contracts/{directory}/target/near/{file}.wasm")
        elif wasm.stat().st_mtime < newest_source(crate):
            stale.append(f"contracts/{directory}")
    if missing:
        return fail(f"{name}: wasm not built ({', '.join(missing)}); run `make wasm`")
    if stale:
        return fail(f"{name}: wasm older than its sources ({', '.join(stale)}); run `make wasm`")
    if proof_dir(root).resolve() == (root / "proofs" / "attack" / "reproducible").resolve():
        directory, file = WASM[0]
        problem = provenance_problem(root, root / "contracts" / directory / "target" / "near" / f"{file}.wasm")
        if problem:
            return fail(f"{name}: {problem}; committed proofs come from `make attack-proofs` on a clean, committed checkout")

    try:
        binary = test_binary(name, root)
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as err:
        return fail(f"{name}: cannot read its test binary from the registry: {err!r}")
    proof_path = proof_dir(root) / f"{name}.json"
    proof_path.unlink(missing_ok=True)
    command = [*cargo, "test", "--locked", "--test", binary, name.replace("-", "_"), "--", "--exact"]
    try:
        # cargo's output goes to stderr so stdout stays the dispatcher's status lines.
        code = subprocess.run(command, cwd=root / "sandbox", stdout=sys.stderr).returncode
    except OSError as err:
        return fail(f"{name}: cannot run {command[0]}: {err}")

    try:
        proof = json.loads(proof_path.read_text())
        verdict = proof["verdict"]
        observed = proof["observed_codes"]
        # web/lib/proof/sample.ts shows "Pass" for result == "PASS" and "Fail" for anything else.
        if proof["result"] != {"held": "PASS", "breached": "FAIL"}.get(verdict):
            return fail(f"{name}: proof result {proof['result']!r} does not match verdict {verdict!r}")
        if proof["attack"] != name:
            return fail(f"{name}: proof is for {proof['attack']!r}")
        expected = registry_codes(root, name)
        if proof["expected_codes"] != expected:
            return fail(f"{name}: proof expects {proof['expected_codes']}, registry {expected}")
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as err:
        return fail(f"{name}: no usable proof at {proof_path} (cargo exit {code}): {err!r}")

    try:
        record_source_commit(proof_path, proof, root)
    except OSError as err:
        return fail(f"{name}: cannot record source_commit in {proof_path}: {err!r}")

    stray = [code for code in observed if code not in expected]
    if verdict == "breached" or stray:
        print(f"BREACHED: {name} observed {observed!r}, expected {expected}", file=sys.stderr)
        return 1
    if verdict == "held" and code == 0:
        return 0
    return fail(f"{name}: verdict {verdict!r} with cargo exit {code}")


def main(name):
    return run(name)
