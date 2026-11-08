#!/usr/bin/env python3
"""Writes the dependency inventory of THIRD_PARTY_NOTICES.md from `cargo metadata` and package-lock.json.

Standard library only, but it runs `cargo metadata --locked --all-features` on every Cargo.toml in
the repository (the lockfiles list the dependencies of optional features too), which downloads
crates it does not have yet, so it needs cargo and network once. A license is read from the
crate's manifest or the lockfile entry; when there is none the inventory says so and nothing is
guessed. Only the region between the BEGIN and END markers is rewritten, so the font notices
above it stay as the lead wrote them.
Exit codes: 0 written (or unchanged with --check), 1 the file differs (--check), 2 a tool failed.
"""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BEGIN = "<!-- BEGIN GENERATED: tools/third_party.py -->"
END = "<!-- END GENERATED -->"
FILE_ONLY = "no license field in the manifest (license file only)"
NOT_DECLARED = "not declared in the manifest"
# Workspace members that are test harnesses and are never deployed. Their dependencies are test tooling
# even when Cargo lists them as normal dependencies (near-workspaces is one of sandbox/).
TEST_ONLY_PACKAGES = {"foundling-sandbox"}


def rust_from_metadata(meta):
    reached = {node["id"] for node in meta["resolve"]["nodes"]}
    found = {}
    for package in meta["packages"]:
        if package["id"] not in reached or not package.get("source"):
            continue
        license_ = package.get("license") or (FILE_ONLY if package.get("license_file") else NOT_DECLARED)
        found[(package["name"], package["version"])] = license_
    return found


def rust_dev_from_metadata(meta):
    """Registry crates that only a dev-dependency edge reaches: test tooling, not part of what runs.

    A crate any normal or build edge reaches from a workspace member ships; so does everything such a
    crate pulls in. A member in TEST_ONLY_PACKAGES is not a starting point. What is left among the
    reached registry crates is dev.
    """
    nodes = {node["id"]: node for node in meta["resolve"]["nodes"]}
    names = {package["id"]: package["name"] for package in meta["packages"]}
    roots = [m for m in meta.get("workspace_members", []) if names.get(m) not in TEST_ONLY_PACKAGES]
    shipped, todo = set(roots), list(roots)
    while todo:
        for dep in nodes.get(todo.pop(), {}).get("deps", []):
            kinds = {kind.get("kind") for kind in dep.get("dep_kinds", [])} or {None}
            if kinds != {"dev"} and dep["pkg"] not in shipped:
                shipped.add(dep["pkg"])
                todo.append(dep["pkg"])
    by_id = {package["id"]: package for package in meta["packages"]}
    return {(by_id[i]["name"], by_id[i]["version"]) for i in nodes
            if i in by_id and by_id[i].get("source") and i not in shipped}


def merge_dev(parts):
    """Dev overall only if every manifest that has the crate says dev. parts: [(found, dev), ...]."""
    present = set().union(*(found for found, _ in parts)) if parts else set()
    return {key for key in present if all(key in dev for found, dev in parts if key in found)}


def npm_license(entry):
    value = entry.get("license")
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict) and isinstance(value.get("type"), str):
        return value["type"]
    return NOT_DECLARED


def npm_from_lock(lock):
    found = {}
    for key, entry in lock.get("packages", {}).items():
        if not key or "node_modules/" not in key or entry.get("link") or not entry.get("version"):
            continue
        name = key.rsplit("node_modules/", 1)[1]
        license_, dev = npm_license(entry), bool(entry.get("dev"))
        known = found.get((name, entry["version"]))
        if known:
            license_ = known[0] if known[0] != NOT_DECLARED else license_
            dev = known[1] and dev
        found[(name, entry["version"])] = (license_, dev)
    return found


def merge(*parts):
    merged = {}
    for part in parts:
        merged.update(part)
    return merged


def group(items):
    """license -> sorted list of "name version" labels."""
    groups = defaultdict(list)
    for label, license_ in items:
        groups[license_].append(label)
    return {license_: sorted(labels) for license_, labels in groups.items()}


def render_ecosystem(title, groups):
    total = sum(len(labels) for labels in groups.values())
    order = sorted(groups, key=lambda license_: (-len(groups[license_]), license_))
    lines = [f"### {title} ({total})", "", "| License | Count |", "| --- | --- |"]
    lines += [f"| {license_} | {len(groups[license_])} |" for license_ in order]
    for license_ in order:
        lines += ["", f"#### {license_}", "", ", ".join(groups[license_])]
    return lines


def render(rust, npm, rust_dev=frozenset()):
    rust_groups = group((f"{name} {version}" + (" (dev)" if (name, version) in rust_dev else ""), license_)
                        for (name, version), license_ in rust.items())
    npm_groups = group((f"{name} {version}" + (" (dev)" if dev else ""), license_)
                       for (name, version), (license_, dev) in npm.items())
    lines = [
        "## Dependencies and their licenses",
        "",
        "This inventory is generated by `python3 tools/third_party.py` from the Rust dependency graphs of every "
        "`Cargo.toml` in the repository and from `package-lock.json`. Each license is read from the crate's "
        "manifest or the lockfile entry; nothing is guessed, and a package that declares none is listed as such. "
        "The license texts are in each package's source and are not copied here. Packages marked `(dev)` are "
        "used only to develop and test: npm devDependencies, and Rust crates reached only through "
        "dev-dependencies or the test harness. Rust build-dependencies are not marked, because they build what runs. The license of this project is in `LICENSE`.",
        "",
    ]
    lines += render_ecosystem("Rust crates", rust_groups) + [""]
    lines += render_ecosystem("npm packages", npm_groups)
    return "\n".join(lines)


def splice(text, section):
    block = f"{BEGIN}\n{section}\n{END}"
    if BEGIN in text and END in text:
        head, rest = text.split(BEGIN, 1)
        tail = rest.split(END, 1)[1]
        return head + block + tail
    return text.rstrip("\n") + "\n\n" + block + "\n"


def gather_rust(root):
    listed = subprocess.run(["git", "ls-files", "*Cargo.toml"], cwd=root, capture_output=True, text=True, check=True)
    parts, devs = [], []
    for manifest in sorted(listed.stdout.split()):
        done = subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked", "--all-features", "--manifest-path", manifest],
                              cwd=root, capture_output=True, text=True)
        if done.returncode:
            raise RuntimeError(f"cargo metadata failed for {manifest}: {done.stderr.strip()[:300]}")
        meta = json.loads(done.stdout)
        parts.append(rust_from_metadata(meta))
        devs.append(rust_dev_from_metadata(meta))
    return merge(*parts), merge_dev(list(zip(parts, devs)))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="tools/third_party.py", description="Update THIRD_PARTY_NOTICES.md")
    parser.add_argument("--check", action="store_true", help="write nothing; exit 1 if the file would change")
    parser.add_argument("--root", default=str(ROOT))
    args = parser.parse_args(argv)
    root = Path(args.root)
    notices = root / "THIRD_PARTY_NOTICES.md"
    try:
        rust, rust_dev = gather_rust(root)
        npm = npm_from_lock(json.loads((root / "package-lock.json").read_text(encoding="utf-8")))
        current = notices.read_text(encoding="utf-8")
        updated = splice(current, render(rust, npm, rust_dev))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as err:
        print(f"ERROR {err}", file=sys.stderr)
        return 2
    if args.check:
        if updated != current:
            print("THIRD_PARTY_NOTICES.md is out of date: run `python3 tools/third_party.py`.", file=sys.stderr)
            return 1
        return 0
    notices.write_text(updated, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
