"""Runs one sandbox attack for tools/attack.py: `cargo test` in sandbox/, then the verdict.

The Rust test writes proofs/attack/<name>.json before it asserts, with `verdict` set to
"held" or "breached". Exit codes follow the dispatcher: 0 held, 1 breached, 2 tool error.
Without a proof the test never reached a verdict (a build error, a missing wasm, a failed
harness call), which is 2 and never a pass or a fail of the attack.
"""
import json
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


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    return 2


def registry_codes(root, name):
    attacks = json.loads((root / "tools" / "attack-registry.json").read_text())["attacks"]
    return next(a["codes"] for a in attacks if a["name"] == name)


def run(name, root=ROOT, cargo=("cargo",)):
    root = Path(root)
    missing = [
        f"contracts/{d}/target/near/{f}.wasm"
        for d, f in WASM
        if not (root / "contracts" / d / "target" / "near" / f"{f}.wasm").is_file()
    ]
    if missing:
        return fail(f"{name}: wasm not built ({', '.join(missing)}); run `make wasm`")

    proof_path = root / "proofs" / "attack" / f"{name}.json"
    proof_path.unlink(missing_ok=True)
    command = [*cargo, "test", "--locked", "--test", TEST_BINARY, name.replace("-", "_"), "--", "--exact", "--include-ignored"]
    try:
        # cargo's output goes to stderr so stdout stays the dispatcher's status lines.
        code = subprocess.run(command, cwd=root / "sandbox", stdout=sys.stderr).returncode
    except OSError as err:
        return fail(f"{name}: cannot run {command[0]}: {err}")

    try:
        proof = json.loads(proof_path.read_text())
        verdict = proof["verdict"]
        if proof["attack"] != name:
            return fail(f"{name}: proof is for {proof['attack']!r}")
        expected = registry_codes(root, name)
        if proof["expected_codes"] != expected:
            return fail(f"{name}: proof expects {proof['expected_codes']}, registry {expected}")
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as err:
        return fail(f"{name}: no usable proof at {proof_path} (cargo exit {code}): {err!r}")

    if verdict == "breached":
        print(f"BREACHED: {name} observed {proof.get('observed_codes')!r}, expected {expected}", file=sys.stderr)
        return 1
    if verdict == "held" and code == 0:
        return 0
    return fail(f"{name}: verdict {verdict!r} with cargo exit {code}")


def main(name):
    return run(name)
