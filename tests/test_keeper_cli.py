"""The keeper command line: configuration, an end-to-end run through the near-cli wrapper,
and the promise that nothing printed or logged carries key material."""

import builtins
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.keeper_fakes import KEEPER, VAULT, World
from tools.keeper.__main__ import main, parse_config
from tools.keeper.bot import ConfigError
from tools.keeper.near_cli import NearCliError

SECRET = "ed25519:" + "3Hq7" * 22
RPCS = "https://a.example,https://b.example"


def env(**extra):
    base = {"FOUNDLING_VAULT": VAULT, "FOUNDLING_KEEPER_ACCOUNT": KEEPER, "FOUNDLING_RPC_URLS": RPCS}
    return {**base, **extra}


class Workspace(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name)
        self.key_file = self.path / "keeper-key.json"
        self.key_file.write_text(json.dumps({"account_id": KEEPER, "private_key": SECRET}))
        self.log = self.path / "soak.jsonl"

    def run_main(self, argv, environ, world, runner, seconds=200, stop_after_cycles=None):
        stderr = io.StringIO()
        start = world.now

        def stop():
            if stop_after_cycles and self.log.exists():
                return self.log.read_text().count('"kind":"cycle"') >= stop_after_cycles
            return world.now - start > seconds

        code = main(argv, environ, stderr, rpc=world, runner=runner, sleep=world.sleep,
                    clock=world.clock, stop=stop)
        return code, stderr.getvalue()

    def environ(self, **extra):
        return env(**{"FOUNDLING_KEEPER_KEY_FILE": str(self.key_file),
                      "FOUNDLING_KEEPER_LOG": str(self.log), **extra})


def world_runner(world):
    """near-cli as the model vault sees it: parses the argv the wrapper built."""

    def runner(argv, timeout):
        result = world.apply(argv[5], json.loads(argv[7]), int(argv[9].split()[0]))
        if result.ok:
            return 0, f"Transaction ID: {result.tx_hash}\n"
        return 1, f"Error: {result.error}\nLocation: src/x.rs\n"

    return runner


class RunTest(Workspace):
    def test_runs_a_full_cycle_through_the_cli_wrapper(self):
        world = World(cooldown=3600)
        code, _ = self.run_main(["run"], self.environ(), world, world_runner(world), stop_after_cycles=1)
        self.assertEqual(code, 0)
        (record,) = [json.loads(line) for line in self.log.read_text().splitlines() if '"cycle"' in line]
        self.assertEqual((record["nonce"], record["result"]), (1, "Executed"))
        self.assertEqual([t["method"] for t in record["txs"]], ["trigger_cycle", "execute_decision"])

    def test_never_logs_key_material(self):
        world = World(cooldown=3600)
        world.last_trigger = world.now - 10  # makes every trigger fail, so the error path runs
        real_open = builtins.open

        def guarded(file, *args, **kwargs):
            if str(file) == str(self.key_file):
                raise AssertionError("the key file was opened")
            return real_open(file, *args, **kwargs)

        def leaky_runner(argv, timeout):
            self.assertIn(str(self.key_file), argv, "the path is handed to near-cli")
            return 1, f"Error: cannot sign with {SECRET} from {self.key_file}\n"

        with mock.patch("builtins.open", guarded), mock.patch("io.open", guarded):
            code, stderr = self.run_main(["run"], self.environ(), world, leaky_runner, seconds=90)
        self.assertEqual(code, 0)
        written = "".join(p.read_text() for p in self.path.iterdir() if p != self.key_file)
        self.assertIn("call_failed", written, "the failure itself was logged")
        for text in (written, stderr):
            self.assertNotIn(SECRET, text)
            self.assertNotIn("3Hq7", text)
            self.assertNotIn(str(self.key_file), text)


class ConfigTest(Workspace):
    def test_arguments_override_the_environment(self):
        config, _ = parse_config(["run", "--vault", "other.test"], self.environ())
        self.assertEqual(config.vault, "other.test")
        self.assertEqual(config.keeper_account, KEEPER)

    def test_a_missing_vault_is_a_usage_error_that_names_the_variable(self):
        world = World()
        environ = self.environ()
        del environ["FOUNDLING_VAULT"]
        code, stderr = self.run_main(["run"], environ, world, world_runner(world))
        self.assertEqual(code, 2)
        self.assertIn("FOUNDLING_VAULT", stderr)

    def test_a_missing_key_file_is_a_usage_error_that_does_not_echo_the_path(self):
        world = World()
        code, stderr = self.run_main(["run"], self.environ(FOUNDLING_KEEPER_KEY_FILE="/nope/key.json"),
                                     world, world_runner(world))
        self.assertEqual(code, 2)
        self.assertIn("FOUNDLING_KEEPER_KEY_FILE", stderr)
        self.assertNotIn("/nope/key.json", stderr)

    def test_testnet_has_default_endpoints_and_other_networks_do_not(self):
        environ = self.environ()
        del environ["FOUNDLING_RPC_URLS"]
        _, urls = parse_config(["run"], environ)
        self.assertGreaterEqual(len(set(urls)), 2)
        with self.assertRaises(ConfigError):
            parse_config(["run", "--network", "mainnet", "--allow-mainnet"], environ)

    def test_one_endpoint_is_not_enough(self):
        with self.assertRaises(ConfigError):
            parse_config(["run"], self.environ(FOUNDLING_RPC_URLS="https://a.example"))

    def test_mainnet_is_refused_without_the_flag(self):
        with self.assertRaises(ConfigError):
            parse_config(["run", "--network", "mainnet"], self.environ())


class FailureTest(Workspace):
    def test_a_missing_near_binary_ends_with_a_message_and_exit_2(self):
        world = World(cooldown=3600)

        def runner(argv, timeout):
            raise NearCliError("the near CLI was not found on PATH")

        code, stderr = self.run_main(["run"], self.environ(), world, runner, seconds=30)
        self.assertEqual(code, 2)
        self.assertIn("near CLI", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_a_corrupt_state_file_ends_with_a_message_and_exit_2(self):
        (self.path / "state.json").write_text("{broken")
        world = World()
        code, stderr = self.run_main(["run", "--state", str(self.path / "state.json")], self.environ(),
                                     world, world_runner(world), seconds=10)
        self.assertEqual(code, 2)
        self.assertIn("state file", stderr)

    def test_summary_of_a_missing_log_is_exit_2_with_a_message(self):
        stderr = io.StringIO()
        self.assertEqual(main(["summary", str(self.path / "absent.jsonl")], {}, stderr), 2)
        self.assertIn("absent.jsonl", stderr.getvalue())


class SummaryCommandTest(Workspace):
    def test_exit_code_follows_the_verdict(self):
        good = self.path / "good.jsonl"
        good.write_text('{"kind":"cycle","nonce":1,"result":"Hold","code":"NO_DECISION"}\n')
        bad = self.path / "bad.jsonl"
        bad.write_text('{"kind":"cycle","nonce":1,"result":"Rejected","code":"OVER_CAP"}\n')
        for path, code, word in ((good, 0, "LULUS"), (bad, 1, "GAGAL")):
            out = io.StringIO()
            with mock.patch("sys.stdout", out):
                self.assertEqual(main(["summary", str(path)], {}, io.StringIO()), code)
            self.assertIn(word, out.getvalue())


if __name__ == "__main__":
    unittest.main()
