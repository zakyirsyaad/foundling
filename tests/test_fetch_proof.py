"""fetch_proof.py's RPC choice and opening, with no network."""

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("fetch_proof", ROOT / "tools" / "fetch_proof.py")
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)

BASE = ["--chain", "testnet", "--vault", "v.testnet", "--collateral-bin", "/bin/fv", "--out", "/tmp/p.json"]


class RpcOption(unittest.TestCase):
    def tearDown(self):
        fetch.use_rpcs(None)

    def test_two_rpc_flags_keep_their_order(self):
        args = fetch.build_parser().parse_args(BASE + ["--rpc", "https://a", "--rpc", "https://b", "TX1"])
        self.assertEqual(args.rpc, ["https://a", "https://b"])
        self.assertEqual(args.trigger_tx, ["TX1"])

    def test_without_rpc_the_chain_defaults_are_used(self):
        args = fetch.build_parser().parse_args(BASE + ["TX1"])
        self.assertIsNone(args.rpc)
        fetch.use_rpcs(args.rpc)
        seen = []
        with mock.patch.object(fetch, "read_json", side_effect=lambda url, body=None: seen.append(url) or {"result": 1}):
            self.assertEqual(fetch.rpc("testnet", "block", {}), 1)
        self.assertEqual(seen, [fetch.CHAINS["testnet"]["rpcs"][0]])

    def test_given_rpcs_replace_the_defaults_and_fail_over_in_order(self):
        fetch.use_rpcs(["https://archival-a", "https://archival-b"])
        seen = []

        def reply(url, body=None):
            seen.append(url)
            if url == "https://archival-a":
                raise OSError("429")
            return {"result": {"ok": True}}

        with mock.patch.object(fetch, "read_json", side_effect=reply), mock.patch.object(fetch.time, "sleep"):
            self.assertEqual(fetch.rpc("mainnet", "block", {}), {"ok": True})
        self.assertEqual(seen, ["https://archival-a", "https://archival-b"])

    def test_main_passes_the_rpc_flags_on(self):
        argv = ["fetch_proof.py"] + BASE + ["--rpc", "https://only", "TX1"]
        with mock.patch.object(fetch.sys, "argv", argv), mock.patch.object(fetch, "build", side_effect=fetch.SourceError("stop")), \
                self.assertRaises(SystemExit) as code:
            fetch.main()
        self.assertEqual(code.exception.code, fetch.TOOL_FAILED)
        self.assertEqual(fetch.ACTIVE_RPCS, ["https://only"])


class OpeningFromViews(unittest.TestCase):
    def views(self, revealed, salt):
        return lambda chain, account, method: {"revealed": revealed, "revealed_salt": salt}[method]

    def test_a_revealed_vault_without_a_reveal_tx_reads_both_views(self):
        with mock.patch.object(fetch, "view", side_effect=self.views('{"risk":3}', "abc")):
            self.assertEqual(fetch.opening_of("testnet", "v.testnet", None, None), {"params": '{"risk":3}', "salt": "abc"})

    def test_a_revealed_vault_without_a_salt_view_is_a_source_error(self):
        with mock.patch.object(fetch, "view", side_effect=self.views('{"risk":3}', None)):
            with self.assertRaises(fetch.SourceError):
                fetch.opening_of("testnet", "v.testnet", None, None)

    def test_a_sealed_vault_has_no_opening(self):
        with mock.patch.object(fetch, "view", side_effect=self.views(None, None)):
            self.assertIsNone(fetch.opening_of("testnet", "v.testnet", None, None))

    def test_a_reveal_tx_still_checks_the_log(self):
        status = {"receipts_outcome": []}
        with mock.patch.object(fetch, "view", side_effect=self.views('{"risk":3}', "abc")), \
                mock.patch.object(fetch, "tx_status", return_value=status):
            with self.assertRaises(fetch.SourceError):
                fetch.opening_of("testnet", "v.testnet", "TXR", "keeper.testnet")


if __name__ == "__main__":
    unittest.main()
