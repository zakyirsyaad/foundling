#!/usr/bin/env python3
"""Attack Lab dispatcher: `foundling attack list|run <name>|run-all`.

Exit codes per attack: 0 = system held, 1 = attack succeeded or reason code
differed, 2 = tool or network error. An attack without a script under
tools/attacks/ is NOT_IMPLEMENTED and exits 2.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_REGISTRY = HERE / "attack-registry.json"
DEFAULT_ATTACKS_DIR = HERE / "attacks"
STATUSES = ("PASS", "FAIL", "NOT_IMPLEMENTED", "ERROR")
ATTACK_TIMEOUT_SECONDS = 300
ATTACK_NAME = re.compile(r"[a-z][a-z0-9-]*")


class BadRegistry(Exception):
    pass


def load_registry(path):
    try:
        attacks = json.loads(Path(path).read_text())["attacks"]
        names = [a["name"] for a in attacks]
    except (OSError, ValueError, KeyError, TypeError) as err:
        raise BadRegistry(f"cannot read {path}: {err!r}") from err
    bad = [n for n in names if not isinstance(n, str) or not ATTACK_NAME.fullmatch(n)]
    if bad:
        raise BadRegistry(f"{path} has invalid attack names: {bad!r}")
    if not names:
        raise BadRegistry(f"{path} has no attacks")
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise BadRegistry(f"{path} has duplicate attacks: {', '.join(duplicates)}")
    return attacks


def find_script(attacks_dir, name):
    """Return (script, executable); script is None when no file exists."""
    for suffix in ("", ".sh", ".py"):
        candidate = Path(attacks_dir) / f"{name}{suffix}"
        if candidate.is_file():
            return candidate, os.access(candidate, os.X_OK)
    return None, False


def run_attack(name, registry, attacks_dir, timeout=ATTACK_TIMEOUT_SECONDS):
    """Run one attack and return (exit_code, status)."""
    if name not in {a["name"] for a in registry}:
        print(f"UNKNOWN_ATTACK: {name}", file=sys.stderr)
        return 2, "ERROR"
    script, executable = find_script(attacks_dir, name)
    if script is None:
        print(f"NOT_IMPLEMENTED: {name}", file=sys.stderr)
        return 2, "NOT_IMPLEMENTED"
    if not executable:
        print(f"NOT_EXECUTABLE: {script} (chmod +x it)", file=sys.stderr)
        return 2, "ERROR"
    try:
        code = subprocess.run([str(script)], timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT: {name} (no exit after {timeout}s)", file=sys.stderr)
        return 2, "ERROR"
    except OSError as err:
        print(f"ERROR: cannot run {script}: {err}", file=sys.stderr)
        return 2, "ERROR"
    status = {0: "PASS", 1: "FAIL"}.get(code, "ERROR")
    return {"PASS": 0, "FAIL": 1, "ERROR": 2}[status], status


def run_all(registry, attacks_dir, timeout=ATTACK_TIMEOUT_SECONDS, strict=False):
    counts = dict.fromkeys(STATUSES, 0)
    width = max(len(a["name"]) for a in registry)
    for attack in registry:
        _, status = run_attack(attack["name"], registry, attacks_dir, timeout)
        counts[status] += 1
        print(f"{attack['name']:<{width}}  {status}", flush=True)
    print(" ".join(f"{s}={counts[s]}" for s in STATUSES))
    if counts["FAIL"]:
        return 1
    if counts["ERROR"] or (strict and counts["NOT_IMPLEMENTED"]):
        return 2
    return 0


def main(argv):
    parser = argparse.ArgumentParser(prog="foundling attack")
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    parser.add_argument("--attacks-dir", default=DEFAULT_ATTACKS_DIR)
    parser.add_argument("--timeout", type=float, default=ATTACK_TIMEOUT_SECONDS)
    parser.add_argument(
        "--strict", action="store_true", help="run-all: NOT_IMPLEMENTED exits 2"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("run-all")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("name")
    args = parser.parse_args(argv)

    try:
        registry = load_registry(args.registry)
    except BadRegistry as err:
        print(f"BAD_REGISTRY: {err}", file=sys.stderr)
        return 2
    if args.cmd == "list":
        for attack in registry:
            print(attack["name"])
        return 0
    if args.cmd == "run-all":
        return run_all(registry, args.attacks_dir, args.timeout, args.strict)
    return run_attack(args.name, registry, args.attacks_dir, args.timeout)[0]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
