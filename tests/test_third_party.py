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


if __name__ == "__main__":
    unittest.main()
