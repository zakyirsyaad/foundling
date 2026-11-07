#!/usr/bin/env python3
"""Builds README.md from tools/readme_template.md, claims.json and proofs/expected/verify-offline.txt.

Standard library only. `python3 tools/readme.py` writes README.md; `--check` writes nothing and
exits 1 when README.md differs from what the inputs build, which is how CI catches drift.
Only claims with status `pass` are written as claims (SPEC 9.3); the others are listed under
"Not proven yet" with their downgrade text. Exit codes: 0 ok, 1 drift, 2 an input is wrong.
"""

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATUSES = ("pass", "skip", "fail")
MAX_CLAIMS = 12
CLAIM_KEYS = ("id", "claim", "tracks", "code_refs", "test_refs", "evidence", "checks", "status", "downgrade")
CHECK_KEYS = ("tier", "cmd", "requires", "network", "seconds", "expect")
PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


class ReadmeError(Exception):
    pass


def load_claims(path):
    try:
        claims = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise ReadmeError(f"cannot read {path}: {err}") from err
    if not isinstance(claims, list) or not claims:
        raise ReadmeError("claims.json must be a non-empty list")
    if len(claims) > MAX_CLAIMS:
        raise ReadmeError(f"claims.json has {len(claims)} claims; the limit is {MAX_CLAIMS}")
    seen = set()
    for claim in claims:
        if not isinstance(claim, dict):
            raise ReadmeError("every claim must be an object")
        missing = [key for key in CLAIM_KEYS if key not in claim]
        if missing:
            raise ReadmeError(f"claim {claim.get('id', '?')} lacks {', '.join(missing)}")
        if claim["id"] in seen:
            raise ReadmeError(f"claim id {claim['id']} appears twice")
        seen.add(claim["id"])
        if claim["status"] not in STATUSES:
            raise ReadmeError(f"claim {claim['id']}: status must be one of {', '.join(STATUSES)}")
        if not isinstance(claim["downgrade"], str) or not claim["downgrade"].strip():
            raise ReadmeError(f"claim {claim['id']} has no downgrade text")
        for check in claim["checks"]:
            lacking = [key for key in CHECK_KEYS if key not in check]
            if lacking:
                raise ReadmeError(f"claim {claim['id']}: a check lacks {', '.join(lacking)}")
    return claims


def cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def link(path):
    return f"[`{path}`]({path})"


def claims_table(claims, root):
    rows = ["| Claim (status from [claims.json](claims.json)) | Evidence | Command | Runs | Status |",
            "| --- | --- | --- | --- | --- |"]
    for claim in claims:
        if claim["status"] != "pass":
            continue
        refs = claim["evidence"] or claim["test_refs"]
        if not refs:
            raise ReadmeError(f"claim {claim['id']} is pass but names neither evidence nor tests")
        if not claim["checks"]:
            raise ReadmeError(f"claim {claim['id']} is pass but has no check to run")
        for ref in claim["evidence"] + claim["test_refs"]:
            if not (Path(root) / ref).exists():
                raise ReadmeError(f"claim {claim['id']} names {ref}, which does not exist")
        evidence = "<br>".join(link(ref) for ref in refs)
        if not claim["evidence"]:
            evidence = "tests: " + evidence
        commands = "<br>".join(f"`{cell(check['cmd'])}`" for check in claim["checks"])
        where = "<br>".join(f"{check['tier']}, {check['network']}" for check in claim["checks"])
        rows.append(f"| {cell(claim['claim'])} | {evidence} | {commands} | {where} | pass |")
    return "\n".join(rows)


def not_proven(claims):
    lines = [f"- `{claim['id']}` ({claim['status']}): {claim['downgrade']}"
             for claim in claims if claim["status"] != "pass"]
    return "\n".join(lines) if lines else "- Every claim in `claims.json` has status pass."


def mainnet_status(root):
    if (Path(root) / "proofs" / "mainnet.json").exists():
        return "The final mainnet vault and its transactions are recorded in [`proofs/mainnet.json`](proofs/mainnet.json)."
    return "No final mainnet vault is recorded in this repository yet (the file proofs/mainnet.json does not exist)."


def roles_text(root):
    """The role paragraph SPEC 9.3 prescribes for the README, copied from the SPEC so it cannot drift."""
    spec = read(Path(root) / "docs" / "SPEC.md", "SPEC")
    for line in spec.splitlines():
        if line.startswith("> **Who holds which key.**"):
            return line[2:]
    raise ReadmeError("docs/SPEC.md has no line starting with '> **Who holds which key.**'")


def render(template, claims, golden, root):
    values = {
        "roles_text": roles_text(root),
        "claims_table": claims_table(claims, root),
        "not_proven": not_proven(claims),
        "verify_last_line": golden.strip().splitlines()[-1],
        "mainnet_status": mainnet_status(root),
    }

    def fill(match):
        if match.group(1) not in values:
            raise ReadmeError(f"the template has an unknown placeholder {{{{{match.group(1)}}}}}")
        return values[match.group(1)]

    text = PLACEHOLDER.sub(fill, template)
    return text if text.endswith("\n") else text + "\n"


def read(path, what):
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as err:
        raise ReadmeError(f"cannot read the {what} {path}: {err}") from err


def main(argv=None):
    parser = argparse.ArgumentParser(prog="tools/readme.py", description="Build README.md from claims.json")
    parser.add_argument("--check", action="store_true", help="write nothing; exit 1 if README.md would change")
    parser.add_argument("--root", default=str(ROOT), help="repository root (paths in claims.json are relative to it)")
    parser.add_argument("--claims", help="default: <root>/claims.json")
    parser.add_argument("--template", help="default: <root>/tools/readme_template.md")
    parser.add_argument("--golden", help="default: <root>/proofs/expected/verify-offline.txt")
    parser.add_argument("--out", help="default: <root>/README.md")
    args = parser.parse_args(argv)
    root = Path(args.root)
    out = Path(args.out) if args.out else root / "README.md"
    try:
        claims = load_claims(args.claims or root / "claims.json")
        template = read(args.template or root / "tools" / "readme_template.md", "template")
        golden = read(args.golden or root / "proofs" / "expected" / "verify-offline.txt", "golden output")
        expected = render(template, claims, golden, root)
    except ReadmeError as err:
        print(f"ERROR {err}", file=sys.stderr)
        return 2
    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current == expected:
            return 0
        print(f"{out.name} is out of date: run `make readme` and commit the result.", file=sys.stderr)
        diff = difflib.unified_diff(current.splitlines(), expected.splitlines(), "committed", "built", lineterm="", n=1)
        print("\n".join(list(diff)[:40]), file=sys.stderr)
        return 1
    out.write_text(expected, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
