#!/usr/bin/env python3
"""Attack Lab dispatcher: `foundling attack list | run NAME [--timeout S] | run-all [--timeout S] [--strict]`.

Exit codes per attack: 0 = system held, 1 = attack succeeded or reason code
differed, 2 = tool or network error. An attack without a script under
tools/attacks/ is NOT_IMPLEMENTED and exits 2. To implement one, add an
executable tools/attacks/<name>[.sh|.py] that follows the same exit codes.
A script that does not exit within --timeout seconds is killed with its
children and counts as ERROR. run-all --strict also exits 2 on NOT_IMPLEMENTED.
"""
import argparse
import json
import math
import os
import re
import signal
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
        # Own session so a timeout can kill the whole group, not just the script.
        with subprocess.Popen([str(script)], start_new_session=True) as proc:
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                print(f"TIMEOUT: {name} (no exit after {timeout}s)", file=sys.stderr)
                return 2, "ERROR"
            except KeyboardInterrupt:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                raise
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


def seconds(text):
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError(f"must be a finite number above 0, got {text!r}")
    return value


def main(argv):
    parser = argparse.ArgumentParser(prog="foundling attack")
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    parser.add_argument("--attacks-dir", default=DEFAULT_ATTACKS_DIR)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    run_all_parser = sub.add_parser("run-all")
    run_all_parser.add_argument(
        "--strict", action="store_true", help="NOT_IMPLEMENTED exits 2"
    )
    run_parser = sub.add_parser("run")
    run_parser.add_argument("name")
    for p in (run_all_parser, run_parser):
        p.add_argument("--timeout", type=seconds, default=ATTACK_TIMEOUT_SECONDS)
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
