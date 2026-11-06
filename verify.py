#!/usr/bin/env python3
"""Foundling verifier, tier 0a: offline checks over committed fixtures.

Standard library only. This path must never open a network connection.
Exit codes: 0 no claim failed (PASS or SKIP only), 1 a claim failed, 2 the tool
could not run or a fixture is not shaped as expected.
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
ACCOUNT_ID = re.compile(r"(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*")
DEFAULT_PROOFS = Path(__file__).resolve().parent / "proofs"
CHECK_NAMES = ("commitment", "keys")
KEYS_LABELS = {"KEYS_NONEMPTY": "present", "KEYS_WRONG_ACCOUNT": "unverified"}

EXIT_OK, EXIT_FAIL, EXIT_TOOL = 0, 1, 2


@dataclass(frozen=True)
class Result:
    name: str
    status: str
    reason: str
    detail: str
    synthetic: bool = False

    def line(self):
        tag = " [synthetic]" if self.synthetic else ""
        if self.status == "PASS":
            return f"PASS {self.name}{tag}: {self.detail}"
        return f"{self.status} {self.name}{tag}: {self.reason}: {self.detail}"


class ToolError(Exception):
    pass


def hash_fields(tag, fields):
    digest = hashlib.sha256(tag)
    for field in fields:
        digest.update(len(field).to_bytes(4, "big"))
        digest.update(field)
    return digest.hexdigest()


def require_text(data, field, where):
    value = data.get(field)
    if not isinstance(value, str):
        raise ToolError(f"{where}: {field} must be a string")
    return value


def require_account(value, where):
    if not (isinstance(value, str) and 2 <= len(value) <= 64 and ACCOUNT_ID.fullmatch(value)):
        raise ToolError(f"{where} is not a NEAR account id")
    return value


def check_commitment(data):
    where = "commitment fixture"
    chain = require_text(data, "chain", where)
    vault = require_account(data.get("vault"), f"{where}: vault")
    wasm_hash = require_text(data, "wasm_hash", where)
    commitment = require_text(data, "commitment", where)
    synthetic = data.get("synthetic") is True

    def result(status, reason, detail):
        return Result("commitment", status, reason, detail, synthetic)

    if not HEX64.fullmatch(commitment):
        return result("FAIL", "COMMITMENT_FORMAT", "commitment is not 64 lowercase hex characters")
    params, salt = data.get("params"), data.get("salt")
    if params is None and salt is None:
        return result(
            "SKIP",
            "COMMITMENT_NOT_REVEALED",
            "params and salt are published only at reveal; the commitment format is valid",
        )
    if not isinstance(params, str) or not isinstance(salt, str) or not HEX64.fullmatch(salt):
        return result("FAIL", "COMMITMENT_FORMAT", "params and salt must both be present, with a 32-byte hex salt")
    try:
        expected = hash_fields(
            COMMITMENT_TAG,
            [chain.encode(), vault.encode(), wasm_hash.encode(), params.encode(), bytes.fromhex(salt)],
        )
    except UnicodeEncodeError as err:
        raise ToolError(f"{where}: text is not valid unicode") from err
    if expected != commitment:
        return result("FAIL", "COMMITMENT_MISMATCH", "recomputed sha256 differs from the stated commitment")
    return result("PASS", "", "sha256 matches the committed fixture")


def check_keys(data, commitment):
    where = "keys fixture"
    synthetic = data.get("synthetic") is True or commitment.get("synthetic") is True
    account = require_account(data.get("account_id"), f"{where}: account_id")
    vault = require_account(commitment.get("vault"), "commitment fixture: vault")
    response = data.get("response")
    if not isinstance(response, dict):
        raise ToolError(f"{where}: response must be an object")
    if "error" in response:
        raise ToolError(f"{where}: the RPC response is an error")
    rpc_result = response.get("result")
    if not isinstance(rpc_result, dict):
        raise ToolError(f"{where}: response has no result object")
    keys, height = rpc_result.get("keys"), rpc_result.get("block_height")
    if not isinstance(keys, list) or isinstance(height, bool) or not isinstance(height, int):
        raise ToolError(f"{where}: result needs a keys list and an integer block_height")

    def result(status, reason, detail):
        return Result("keys", status, reason, detail, synthetic)

    if account != vault:
        return result("FAIL", "KEYS_WRONG_ACCOUNT", f"keys were read for {account}, not for the vault {vault}")
    if keys:
        return result("FAIL", "KEYS_NONEMPTY", f"{len(keys)} access key(s) for {account} at block {height}; a sealed vault has none")
    return result("PASS", "", f"access key list is empty for {account} at block {height}")


def load_fixture(proofs, name):
    path = Path(proofs) / name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as err:
        raise ToolError(f"cannot read fixture {name}: {err}") from err
    if not isinstance(data, dict):
        raise ToolError(f"fixture {name} is not a JSON object")
    return data


def run(selected, proofs):
    commitment = load_fixture(proofs, "commitment.json")
    results = []
    if "commitment" in selected:
        results.append(check_commitment(commitment))
    if "keys" in selected:
        results.append(check_keys(load_fixture(proofs, "access_keys.json"), commitment))
    return results


def keys_label(results):
    for result in results:
        if result.name == "keys":
            return "none" if result.status == "PASS" else KEYS_LABELS[result.reason]
    return "unchecked"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="verify.py", description="Foundling tier 0a offline verifier")
    parser.add_argument("check", nargs="?", choices=CHECK_NAMES, help="run one check (default: all)")
    parser.add_argument("--proofs", default=str(DEFAULT_PROOFS), help="fixture directory")
    args = parser.parse_args(argv)

    selected = [args.check] if args.check else list(CHECK_NAMES)
    try:
        results = run(selected, args.proofs)
    except ToolError as err:
        print(f"ERROR {err}", file=sys.stderr)
        return EXIT_TOOL
    except Exception as err:  # a broken fixture must never look like a failed claim
        print(f"ERROR unexpected {type(err).__name__} while reading the fixtures", file=sys.stderr)
        return EXIT_TOOL

    print("verify offline (tier 0a)")
    for result in results:
        print(result.line())
    if any(result.synthetic for result in results):
        print("NOTE synthetic fixtures: no real vault was checked")
    passed = sum(r.status == "PASS" for r in results)
    skipped = sum(r.status == "SKIP" for r in results)
    failed = sum(r.status == "FAIL" for r in results)
    print(f"SUMMARY pass={passed} skip={skipped} fail={failed} mode=offline keys={keys_label(results)}")
    return EXIT_FAIL if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
