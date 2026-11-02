#!/usr/bin/env python3
"""Attack Lab dispatcher: `foundling attack list|run <name>|run-all`.

Exit codes per attack: 0 = system held, 1 = attack succeeded or reason code
differed, 2 = tool or network error. An attack without a script under
tools/attacks/ is NOT_IMPLEMENTED and exits 2.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_REGISTRY = HERE / "attack-registry.json"
DEFAULT_ATTACKS_DIR = HERE / "attacks"
STATUSES = ("PASS", "FAIL", "NOT_IMPLEMENTED", "ERROR")


def load_registry(path):
    return json.loads(Path(path).read_text())["attacks"]


def find_script(attacks_dir, name):
    for suffix in ("", ".sh", ".py"):
        candidate = Path(attacks_dir) / f"{name}{suffix}"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def run_attack(name, registry, attacks_dir):
    """Run one attack and return (exit_code, status)."""
    if name not in {a["name"] for a in registry}:
        print(f"UNKNOWN_ATTACK: {name}", file=sys.stderr)
        return 2, "ERROR"
    script = find_script(attacks_dir, name)
    if script is None:
        print(f"NOT_IMPLEMENTED: {name}", file=sys.stderr)
        return 2, "NOT_IMPLEMENTED"
    try:
        code = subprocess.run([str(script)]).returncode
    except OSError as err:
        print(f"ERROR: cannot run {script}: {err}", file=sys.stderr)
        return 2, "ERROR"
    return code, {0: "PASS", 1: "FAIL"}.get(code, "ERROR")


def run_all(registry, attacks_dir):
    counts = dict.fromkeys(STATUSES, 0)
    width = max(len(a["name"]) for a in registry)
    for attack in registry:
        _, status = run_attack(attack["name"], registry, attacks_dir)
        counts[status] += 1
        print(f"{attack['name']:<{width}}  {status}", flush=True)
    print(" ".join(f"{s}={counts[s]}" for s in STATUSES))
    if counts["FAIL"]:
        return 1
    return 2 if counts["ERROR"] else 0


def main(argv):
    parser = argparse.ArgumentParser(prog="foundling attack")
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    parser.add_argument("--attacks-dir", default=DEFAULT_ATTACKS_DIR)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("run-all")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("name")
    args = parser.parse_args(argv)

    registry = load_registry(args.registry)
    if args.cmd == "list":
        for attack in registry:
            print(attack["name"])
        return 0
    if args.cmd == "run-all":
        return run_all(registry, args.attacks_dir)
    return run_attack(args.name, registry, args.attacks_dir)[0]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
