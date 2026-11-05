"""Runs one sandbox attack for tools/attack.py: `cargo test` in sandbox/, then the verdict.

The Rust test writes <proof dir>/<name>.json before it asserts, with `verdict` set to
"held" or "breached". The proof dir is $FOUNDLING_PROOF_DIR, else proofs/attack/local (ignored
by git); proofs/attack itself holds the ones committed from a run on the reproducible build.
Exit codes follow the dispatcher: 0 held, 1 breached, 2 tool error. A breach is a verdict of
"breached", or any observed reason code outside the registry's codes for the attack. Without
a proof the test never reached a verdict (a build error, a missing or stale wasm, a failed
harness call), which is 2 and never a pass or a fail of the attack.
"""
import json
import os
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
    attacks = json.loads((root / "tools" / "attack-registry.json").read_text())["attacks"]
    return next(a["codes"] for a in attacks if a["name"] == name)


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

    proof_path = proof_dir(root) / f"{name}.json"
    proof_path.unlink(missing_ok=True)
    command = [*cargo, "test", "--locked", "--test", TEST_BINARY, name.replace("-", "_"), "--", "--exact"]
    try:
        # cargo's output goes to stderr so stdout stays the dispatcher's status lines.
        code = subprocess.run(command, cwd=root / "sandbox", stdout=sys.stderr).returncode
    except OSError as err:
        return fail(f"{name}: cannot run {command[0]}: {err}")

    try:
        proof = json.loads(proof_path.read_text())
        verdict = proof["verdict"]
        observed = proof["observed_codes"]
        if proof["attack"] != name:
            return fail(f"{name}: proof is for {proof['attack']!r}")
        expected = registry_codes(root, name)
        if proof["expected_codes"] != expected:
            return fail(f"{name}: proof expects {proof['expected_codes']}, registry {expected}")
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as err:
        return fail(f"{name}: no usable proof at {proof_path} (cargo exit {code}): {err!r}")

    stray = [code for code in observed if code not in expected]
    if verdict == "breached" or stray:
        print(f"BREACHED: {name} observed {observed!r}, expected {expected}", file=sys.stderr)
        return 1
    if verdict == "held" and code == 0:
        return 0
    return fail(f"{name}: verdict {verdict!r} with cargo exit {code}")


def main(name):
    return run(name)
