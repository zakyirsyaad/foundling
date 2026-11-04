"""The near-cli wrapper: argument shape, tx id parsing, and keeping key material out of output."""

import builtins
import unittest
from unittest import mock

from tools.keeper.near_cli import NearCli, scrub

KEY_FILE = "/keys/keeper.json"
SECRET = "ed25519:" + "5Kq9" * 22
TX = "9WqzXxJ3kPpd7Hh1m2VnRrYbA4TfLcEu5GsNoDw6iBZy"


class Runner:
    def __init__(self, code=0, output=""):
        self.code, self.output, self.argv = code, output, None

    def __call__(self, argv, timeout):
        self.argv = argv
        return self.code, self.output


def cli(runner):
    return NearCli("keeper.test", KEY_FILE, "testnet", runner=runner)


class ArgvTest(unittest.TestCase):
    def test_follows_the_lib_sh_pattern(self):
        runner = Runner(output=f"Transaction ID: {TX}")
        cli(runner).call("vault.test", "advance", {"nonce": 3}, 150)
        self.assertEqual(runner.argv, [
            "near", "contract", "call-function", "as-transaction", "vault.test", "advance",
            "json-args", '{"nonce": 3}', "prepaid-gas", "150 Tgas", "attached-deposit", "0 NEAR",
            "sign-as", "keeper.test", "network-config", "testnet",
            "sign-with-access-key-file", KEY_FILE, "send",
        ])


class ResultTest(unittest.TestCase):
    def test_a_transaction_id_means_the_call_went_out(self):
        result = cli(Runner(output=f"noise\nTransaction ID: {TX}\nmore")).call("v", "m", {}, 300)
        self.assertTrue(result.ok)
        self.assertEqual(result.tx_hash, TX)

    def test_no_transaction_id_is_a_failure_with_the_error_text(self):
        output = "x\nError: Smart contract panicked: COOLDOWN\nLocation: src/a.rs"
        result = cli(Runner(code=1, output=output)).call("v", "m", {}, 300)
        self.assertFalse(result.ok)
        self.assertIsNone(result.tx_hash)
        self.assertIn("COOLDOWN", result.error)

    def test_a_timeout_is_a_failure_that_may_still_have_landed(self):
        def runner(argv, timeout):
            raise TimeoutError("slow")

        result = NearCli("k.test", KEY_FILE, runner=runner).call("v", "m", {}, 300)
        self.assertFalse(result.ok)
        self.assertIn("timeout", result.error)


class ScrubTest(unittest.TestCase):
    def test_removes_keys_paths_and_color_codes(self):
        text = f'\x1b[31mError\x1b[0m {SECRET} at {KEY_FILE} "private_key": "{SECRET}"'
        clean = scrub(text, KEY_FILE)
        self.assertNotIn(SECRET, clean)
        self.assertNotIn(KEY_FILE, clean)
        self.assertNotIn("\x1b", clean)
        self.assertNotIn("5Kq9", clean)

    def test_leaves_ordinary_text_alone(self):
        self.assertEqual(scrub("Smart contract panicked: LOW_GAS", KEY_FILE),
                         "Smart contract panicked: LOW_GAS")

    def test_a_failure_that_echoes_a_secret_is_scrubbed_in_the_result(self):
        output = f"Error: bad key {SECRET} in {KEY_FILE}"
        result = cli(Runner(code=1, output=output)).call("v", "m", {}, 300)
        self.assertNotIn(SECRET, result.error)
        self.assertNotIn(KEY_FILE, result.error)


class KeyFileTest(unittest.TestCase):
    def test_the_wrapper_never_opens_the_key_file(self):
        real_open = builtins.open

        def guarded(file, *args, **kwargs):
            if str(file) == KEY_FILE:
                raise AssertionError("the key file was opened")
            return real_open(file, *args, **kwargs)

        with mock.patch("builtins.open", guarded):
            cli(Runner(output=f"Transaction ID: {TX}")).call("v", "m", {}, 300)


if __name__ == "__main__":
    unittest.main()
