import json
import os
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTACKS = ROOT / "tools" / "attacks"
BATCH3 = ["inflated-nav", "deflated-sell", "never-flat", "setup-spam", "advance-race"]


def registry():
    return {a["name"]: a for a in json.loads((ROOT / "tools" / "attack-registry.json").read_text())["attacks"]}


class BatchThreeTest(unittest.TestCase):
    def test_each_batch3_attack_has_an_executable_launcher_that_names_itself(self):
        for name in BATCH3:
            script = ATTACKS / name
            self.assertTrue(script.is_file(), name)
            self.assertTrue(os.access(script, os.X_OK), f"{name} is not executable")
            text = script.read_text()
            self.assertTrue(text.startswith("#!/usr/bin/env python3"), name)
            self.assertIn(f'main("{name}")', text)

    def test_the_registry_routes_batch3_to_its_binary_and_the_binary_has_each_test(self):
        source = (ROOT / "sandbox" / "tests" / "attacks_batch3.rs").read_text()
        for name in BATCH3:
            self.assertEqual(registry()[name].get("test_binary"), "attacks_batch3", name)
            self.assertIn(f"async fn {name.replace('-', '_')}()", source, name)

    def test_the_warm_up_compiles_batch3_before_the_attack_clock_starts(self):
        plan = subprocess.run(["make", "-n", "attack-warm"], capture_output=True, text=True, cwd=ROOT).stdout
        self.assertIn("--test attacks_batch3 --no-run", plan)

    def test_every_run_new_code_list_equals_the_registry_codes_in_order(self):
        # The runner fails an attack with exit 2 when the proof's expected codes differ from the registry's.
        for binary in ("attacks_batch2", "attacks_batch3"):
            source = (ROOT / "sandbox" / "tests" / f"{binary}.rs").read_text()
            found = re.findall(r'Run::new\(\s*"([a-z-]+)",\s*&\[([^\]]*)\]\s*,?\s*\)', source)
            self.assertGreaterEqual(len(found), 5, binary)
            for name, codes in found:
                listed = re.findall(r'"([A-Z_]+)"', codes)
                self.assertEqual(listed, registry()[name]["codes"], f"{binary}: {name}")

    def test_all_fifteen_core_attacks_have_a_script(self):
        # The last five land here, so a run-all with --strict has nothing left to call NOT_IMPLEMENTED.
        for name in registry():
            self.assertTrue((ATTACKS / name).is_file(), f"{name} has no script")


if __name__ == "__main__":
    unittest.main()
