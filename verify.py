#!/usr/bin/env python3
"""Foundling verifier, tier 0a: offline checks over committed fixtures.

Standard library only. This path must never open a network connection.
Exit codes: 0 all checks passed, 1 a claim failed, 2 tool or input problem.
"""

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

COMMITMENT_TAG = b"foundling/v1/commitment"
HEX64 = re.compile(r"[0-9a-f]{64}")
DEFAULT_PROOFS = Path(__file__).resolve().parent / "proofs"

EXIT_OK, EXIT_FAIL, EXIT_TOOL = 0, 1, 2


@dataclass(frozen=True)
class Result:
    name: str
    status: str
    reason: str
    detail: str

    def line(self):
        if self.status == "PASS":
            return f"PASS {self.name}: {self.detail}"
        return f"{self.status} {self.name}: {self.reason}: {self.detail}"


class ToolError(Exception):
    pass


def hash_fields(tag, fields):
    digest = hashlib.sha256(tag)
    for field in fields:
        digest.update(len(field).to_bytes(4, "big"))
        digest.update(field)
    return digest.hexdigest()


def check_commitment(data):
    fields = ("chain", "vault", "wasm_hash", "params", "salt", "commitment")
    if not all(isinstance(data.get(f), str) for f in fields):
        return Result("commitment", "FAIL", "COMMITMENT_FORMAT", "fixture is missing a required string field")
    if not HEX64.fullmatch(data["commitment"]):
        return Result("commitment", "FAIL", "COMMITMENT_FORMAT", "commitment is not 64 lowercase hex characters")
    if not HEX64.fullmatch(data["salt"]):
        return Result("commitment", "FAIL", "COMMITMENT_FORMAT", "salt is not 32 bytes of lowercase hex")
    expected = hash_fields(
        COMMITMENT_TAG,
        [
            data["chain"].encode(),
            data["vault"].encode(),
            data["wasm_hash"].encode(),
            data["params"].encode(),
            bytes.fromhex(data["salt"]),
        ],
    )
    if expected != data["commitment"]:
        return Result("commitment", "FAIL", "COMMITMENT_MISMATCH", "recomputed sha256 differs from the stated commitment")
    return Result("commitment", "PASS", "", "sha256 matches the committed fixture")


def check_keys(data):
    keys = data.get("keys")
    account = data.get("account_id")
    if not isinstance(keys, list) or not (account is None or isinstance(account, str)):
        return Result("keys", "FAIL", "KEYS_FORMAT", "fixture needs a keys list and, if present, a string account_id")
    owner = f"for {account}" if account else "for the vault"
    if keys:
        return Result("keys", "FAIL", "KEYS_NONEMPTY", f"{len(keys)} access key(s) {owner}; a sealed vault has none")
    return Result("keys", "PASS", "", f"access key list is empty {owner}")


def load_fixture(proofs, name):
    path = Path(proofs) / name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ToolError(f"cannot read fixture {name}: {err}") from err
    if not isinstance(data, dict):
        raise ToolError(f"fixture {name} is not a JSON object")
    return data


CHECKS = {
    "commitment": ("commitment.json", check_commitment),
    "keys": ("access_keys.json", check_keys),
}


def run(selected, proofs):
    results = []
    for name in selected:
        fixture, check = CHECKS[name]
        results.append(check(load_fixture(proofs, fixture)))
    return results


def keys_label(results):
    for result in results:
        if result.name == "keys":
            if result.status == "PASS":
                return "none"
            return "unknown" if result.reason == "KEYS_FORMAT" else "present"
    return "unchecked"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="verify.py", description="Foundling tier 0a offline verifier")
    parser.add_argument("check", nargs="?", choices=sorted(CHECKS), help="run one check (default: all)")
    parser.add_argument("--proofs", default=str(DEFAULT_PROOFS), help="fixture directory")
    args = parser.parse_args(argv)

    selected = [args.check] if args.check else list(CHECKS)
    try:
        results = run(selected, args.proofs)
    except ToolError as err:
        print(f"ERROR {err}", file=sys.stderr)
        return EXIT_TOOL

    print("verify offline (tier 0a)")
    for result in results:
        print(result.line())
    passed = sum(r.status == "PASS" for r in results)
    skipped = sum(r.status == "SKIP" for r in results)
    failed = sum(r.status == "FAIL" for r in results)
    print(f"SUMMARY pass={passed} skip={skipped} fail={failed} mode=offline keys={keys_label(results)}")
    return EXIT_FAIL if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
