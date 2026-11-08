"""The dependency inventory in THIRD_PARTY_NOTICES.md: read from manifests and lockfiles, never guessed."""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import third_party  # noqa: E402

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
NOTICES = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")


def metadata(*packages, reached=None):
    """A `cargo metadata` answer: each package is (name, version, source, license, license_file)."""
    items = [{"id": f"{n} {v}", "name": n, "version": v, "source": s, "license": lic, "license_file": lf}
             for n, v, s, lic, lf in packages]
    ids = [item["id"] for item in items] if reached is None else reached
    return {"packages": items, "resolve": {"nodes": [{"id": i} for i in ids]}}


class CargoTest(unittest.TestCase):
    def test_only_reachable_packages_from_a_registry_are_listed(self):
        meta = metadata(("a", "1.0.0", REGISTRY, "MIT OR Apache-2.0", None),
                        ("foundling-vault", "0.1.0", None, None, None),
                        ("unreached", "9.9.9", REGISTRY, "MIT", None),
                        reached=["a 1.0.0", "foundling-vault 0.1.0"])
        self.assertEqual(third_party.rust_from_metadata(meta), {("a", "1.0.0"): "MIT OR Apache-2.0"})

    def test_a_crate_with_only_a_license_file_says_so_and_one_with_nothing_says_that(self):
        meta = metadata(("ring", "0.17.0", REGISTRY, None, "LICENSE"), ("odd", "0.1.0", REGISTRY, None, None))
        found = third_party.rust_from_metadata(meta)
        self.assertEqual(found[("ring", "0.17.0")], third_party.FILE_ONLY)
        self.assertEqual(found[("odd", "0.1.0")], third_party.NOT_DECLARED)

    def test_the_same_crate_from_two_manifests_is_listed_once(self):
        one = third_party.rust_from_metadata(metadata(("a", "1.0.0", REGISTRY, "MIT", None)))
        two = third_party.rust_from_metadata(metadata(("a", "1.0.0", REGISTRY, "MIT", None), ("b", "2.0.0", REGISTRY, "ISC", None)))
        self.assertEqual(third_party.merge(one, two), {("a", "1.0.0"): "MIT", ("b", "2.0.0"): "ISC"})


class NpmTest(unittest.TestCase):
    LOCK = {"packages": {
        "": {"name": "root"},
        "web": {"name": "web"},
        "node_modules/web": {"resolved": "web", "link": True},
        "node_modules/next": {"version": "16.0.0", "license": "MIT"},
        "node_modules/@scope/pkg": {"version": "1.2.3", "license": "Apache-2.0", "dev": True},
        "node_modules/a/node_modules/old": {"version": "0.1.0", "license": {"type": "BSD-3-Clause", "url": "x"}},
        "node_modules/silent": {"version": "2.0.0"},
    }}

    def test_names_come_from_the_innermost_node_modules_and_workspace_links_are_skipped(self):
        found = third_party.npm_from_lock(self.LOCK)
        self.assertEqual(sorted(name for name, _ in found), ["@scope/pkg", "next", "old", "silent"])

    def test_license_strings_objects_and_silence_are_read_not_guessed(self):
        found = third_party.npm_from_lock(self.LOCK)
        self.assertEqual(found[("next", "16.0.0")], ("MIT", False))
        self.assertEqual(found[("@scope/pkg", "1.2.3")], ("Apache-2.0", True))
        self.assertEqual(found[("old", "0.1.0")], ("BSD-3-Clause", False))
        self.assertEqual(found[("silent", "2.0.0")], (third_party.NOT_DECLARED, False))


class RenderTest(unittest.TestCase):
    def test_the_section_groups_by_license_with_counts_and_marks_dev_packages(self):
        rust = {("a", "1.0.0"): "MIT", ("b", "2.0.0"): "MIT", ("c", "3.0.0"): "ISC"}
        npm = {("next", "16.0.0"): ("MIT", False), ("tool", "1.0.0"): ("MIT", True)}
        text = third_party.render(rust, npm)
        self.assertIn("### Rust crates (3)", text)
        self.assertIn("### npm packages (2)", text)
        self.assertIn("| MIT | 2 |", text)
        self.assertIn("a 1.0.0, b 2.0.0", text)
        self.assertIn("tool 1.0.0 (dev)", text)
        self.assertNotIn("next 16.0.0 (dev)", text)

    def test_an_undeclared_license_is_stated_not_hidden(self):
        text = third_party.render({("odd", "0.1.0"): third_party.NOT_DECLARED}, {})
        self.assertIn(third_party.NOT_DECLARED, text)
        self.assertIn("odd 0.1.0", text)

    def test_the_output_is_stable_regardless_of_input_order(self):
        rust = {("b", "1"): "MIT", ("a", "1"): "MIT"}
        self.assertEqual(third_party.render(rust, {}), third_party.render(dict(reversed(list(rust.items()))), {}))

    def test_splicing_replaces_only_the_generated_region_and_keeps_the_font_notices(self):
        old = f"# Notices\n\nfonts text\n\n{third_party.BEGIN}\nold list\n{third_party.END}\n\nafter\n"
        new = third_party.splice(old, "NEW LIST")
        self.assertIn("fonts text", new)
        self.assertIn("NEW LIST", new)
        self.assertNotIn("old list", new)
        self.assertTrue(new.endswith("after\n"))
        self.assertEqual(third_party.splice(new, "NEW LIST"), new)

    def test_splicing_into_a_file_without_markers_appends_after_the_existing_text(self):
        new = third_party.splice("# Notices\n\nfonts text\n", "LIST")
        self.assertTrue(new.startswith("# Notices\n\nfonts text\n"))
        self.assertIn(third_party.BEGIN, new)
        self.assertIn("LIST", new)


class CommittedNoticesTest(unittest.TestCase):
    def test_the_fonts_the_lead_documented_are_still_there(self):
        self.assertIn("SIL OPEN FONT LICENSE Version 1.1", NOTICES)
        self.assertIn("## Inter", NOTICES)
        self.assertIn("## Geist Mono", NOTICES)

    def test_every_crate_in_every_cargo_lock_is_listed(self):
        missing = []
        for lock in sorted(ROOT.glob("**/Cargo.lock")):
            if "target" in lock.parts or "node_modules" in lock.parts:
                continue
            text = lock.read_text(encoding="utf-8")
            for name, version, source in re.findall(r'name = "([^"]+)"\nversion = "([^"]+)"\n(source = "[^"]+")?', text):
                if source and f"{name} {version}" not in NOTICES:
                    missing.append(f"{lock.parent.name}: {name} {version}")
        self.assertEqual(missing, [])

    def test_every_package_in_package_lock_is_listed(self):
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
        missing = [f"{name} {version}" for (name, version) in third_party.npm_from_lock(lock)
                   if f"{name} {version}" not in NOTICES]
        self.assertEqual(missing, [])

    def test_the_inventory_says_where_the_texts_are_and_that_nothing_is_guessed(self):
        self.assertIn("nothing is guessed", NOTICES)
        self.assertIn(third_party.BEGIN, NOTICES)
        self.assertIn(third_party.END, NOTICES)


def graph(members, packages, edges):
    """A `cargo metadata` answer with the dependency graph. Edges are (from, to, kind); kind None is a normal dependency."""
    items = [{"id": n, "name": n.split()[0], "version": n.split()[1], "source": None if n in members else REGISTRY,
              "license": "MIT", "license_file": None} for n in packages]
    nodes = []
    for node in packages:
        deps = [{"pkg": to, "dep_kinds": [{"kind": kind, "target": None}]} for src, to, kind in edges if src == node]
        nodes.append({"id": node, "deps": deps})
    return {"packages": items, "workspace_members": list(members), "resolve": {"nodes": nodes}}


class DevCrateTest(unittest.TestCase):
    MEMBER = "vault 0.1.0"

    def dev(self, packages, edges):
        meta = graph([self.MEMBER], [self.MEMBER, *packages], edges)
        return third_party.rust_dev_from_metadata(meta)

    def test_a_crate_reached_only_through_a_dev_dependency_is_dev(self):
        found = self.dev(["near-sdk 5.0.0", "near-workspaces 0.24.0"],
                         [(self.MEMBER, "near-sdk 5.0.0", None), (self.MEMBER, "near-workspaces 0.24.0", "dev")])
        self.assertEqual(found, {("near-workspaces", "0.24.0")})

    def test_what_a_dev_crate_pulls_in_is_dev_too(self):
        found = self.dev(["near-workspaces 0.24.0", "tokio 1.0.0"],
                         [(self.MEMBER, "near-workspaces 0.24.0", "dev"), ("near-workspaces 0.24.0", "tokio 1.0.0", None)])
        self.assertEqual(found, {("near-workspaces", "0.24.0"), ("tokio", "1.0.0")})

    def test_a_crate_that_is_both_normal_and_dev_ships(self):
        found = self.dev(["serde 1.0.0"], [(self.MEMBER, "serde 1.0.0", None), (self.MEMBER, "serde 1.0.0", "dev")])
        self.assertEqual(found, set())

    def test_a_crate_that_a_shipped_crate_needs_ships_even_if_a_dev_crate_also_does(self):
        found = self.dev(["a 1.0.0", "b 1.0.0", "shared 1.0.0"],
                         [(self.MEMBER, "a 1.0.0", None), (self.MEMBER, "b 1.0.0", "dev"),
                          ("a 1.0.0", "shared 1.0.0", None), ("b 1.0.0", "shared 1.0.0", None)])
        self.assertEqual(found, {("b", "1.0.0")})

    def test_a_build_dependency_is_not_marked_dev(self):
        self.assertEqual(self.dev(["cc 1.0.0"], [(self.MEMBER, "cc 1.0.0", "build")]), set())

    def test_workspace_members_themselves_are_never_listed(self):
        self.assertEqual(self.dev([], []), set())

    def test_what_only_a_test_harness_member_needs_is_dev_even_as_a_normal_dependency(self):
        harness = "foundling-sandbox 0.1.0"
        meta = graph([self.MEMBER, harness], [self.MEMBER, harness, "near-workspaces 0.24.0", "serde 1.0.0", "tokio 1.0.0"],
                     [(harness, "near-workspaces 0.24.0", None), (harness, "serde 1.0.0", None),
                      (self.MEMBER, "serde 1.0.0", None), ("near-workspaces 0.24.0", "tokio 1.0.0", None)])
        self.assertEqual(third_party.rust_dev_from_metadata(meta), {("near-workspaces", "0.24.0"), ("tokio", "1.0.0")})

    def test_the_test_harness_members_are_named_in_one_place(self):
        self.assertEqual(third_party.TEST_ONLY_PACKAGES, {"foundling-sandbox"})
        sandbox = (ROOT / "sandbox" / "Cargo.toml").read_text(encoding="utf-8")
        self.assertIn('name = "foundling-sandbox"', sandbox)

    def test_a_dependency_with_several_kinds_is_normal_if_any_is_normal(self):
        meta = graph([self.MEMBER], [self.MEMBER, "x 1.0.0"], [])
        meta["resolve"]["nodes"][0]["deps"] = [{"pkg": "x 1.0.0", "dep_kinds": [{"kind": "dev", "target": None}, {"kind": None, "target": None}]}]
        self.assertEqual(third_party.rust_dev_from_metadata(meta), set())

    def test_a_crate_is_dev_overall_only_if_every_manifest_that_has_it_says_so(self):
        both = {("t", "1"): "MIT", ("n", "1"): "MIT"}
        only_n = {("n", "1"): "MIT"}
        merged = third_party.merge_dev([(both, {("t", "1")}), (only_n, set()), ({("t", "1"): "MIT"}, {("t", "1")})])
        self.assertEqual(merged, {("t", "1")})
        shipped_elsewhere = third_party.merge_dev([(both, {("t", "1")}), ({("t", "1"): "MIT"}, set())])
        self.assertEqual(shipped_elsewhere, set())

    def test_render_marks_rust_dev_crates_and_leaves_the_rest_alone(self):
        rust = {("a", "1.0.0"): "MIT", ("tool", "2.0.0"): "MIT"}
        text = third_party.render(rust, {}, rust_dev={("tool", "2.0.0")})
        self.assertIn("tool 2.0.0 (dev)", text)
        self.assertNotIn("a 1.0.0 (dev)", text)
        self.assertEqual(third_party.render(rust, {}), third_party.render(rust, {}, rust_dev=set()))

    def test_the_committed_inventory_marks_the_test_tooling_and_not_the_runtime(self):
        self.assertRegex(NOTICES, r"near-workspaces \S+ \(dev\)")
        self.assertRegex(NOTICES, r"proptest \S+ \(dev\)")
        self.assertNotRegex(NOTICES, r"near-sdk \S+ \(dev\)")
        self.assertNotRegex(NOTICES, r"serde_json \S+ \(dev\)")


if __name__ == "__main__":
    unittest.main()
