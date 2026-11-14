"""fetch_proof.py's RPC choice and opening, with no network."""

import importlib.util
import json
import re
import unittest
import urllib.error
import urllib.parse
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



CHAT = "96c4d660c8c24433aafa9eac77b20286"
RESP = "865729cb2e02965750d82714848f2498a44062623b3f957d1cdaaf239127b030"
SIGNER = "0x3b753b4406613c5e70ae640508632b600424fa0c"
KEY = "sk-test-archive-key"


def decision(chat_id=CHAT, m=0):
    ai = {"chat_id": chat_id, "resp_sig_hash": RESP if chat_id else ""}
    if m is not None and chat_id:
        ai["m"] = m
    return json.dumps({"ai_ref": ai, "nonce": 1})


EVENTS = [{"imr": 3, "event_type": 134217729, "digest": "", "event": "app-id", "event_payload": "2c0a"}]


def nearai_world(calls, signature_status=200, report_status=200, signature=None, replicas=1):
    """A fake NEAR AI: records each call and answers like the real endpoints. A status may be a list,
    one per call, for a reply that changes between attempts."""
    statuses = {"signature": signature_status, "report": report_status}

    def status_of(name):
        value = statuses[name]
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        return value

    def reply(url, body=None, headers=None):
        calls.append((url, dict(headers or {})))
        parsed = urllib.parse.urlparse(url)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        if "/signature/" in parsed.path:
            status = status_of("signature")
            if status != 200:
                raise urllib.error.HTTPError(url, status, "x", {}, None)
            if signature is not None:
                return signature
            return {"text": f"{query['model']}:{'ab' * 32}:{RESP}", "signature": "0x" + "11" * 65,
                    "signing_address": SIGNER, "signing_algo": "ecdsa", "signature_kind": "provider_tee"}
        if parsed.path.endswith("/attestation/report"):
            status = status_of("report")
            if status != 200:
                raise urllib.error.HTTPError(url, status, "x", {}, None)
            entry = {"model_name": query["model"], "signing_address": query["signing_address"],
                     "request_nonce": query["nonce"], "intel_quote": "0400", "nvidia_payload": "{}", "event_log": EVENTS}
            other = dict(entry, signing_address="0x" + "22" * 20)
            # NEAR AI runs several replicas of one model behind one signing key, each with its own quote.
            mine = [dict(entry, intel_quote=f"04{n:02x}") for n in range(replicas)]
            return {"gateway_attestation": {}, "model_attestations": [other, *mine]}
        raise AssertionError(url)

    return reply


class AdvisorSignature(unittest.TestCase):
    def archive(self, text, key=KEY, **world):
        calls = []
        with mock.patch.object(fetch, "read_json", side_effect=nearai_world(calls, **world)), \
                mock.patch.object(fetch.time, "sleep"), \
                mock.patch.object(fetch, "collateral_of_bytes", return_value={"tcb_info": "c"}) as collateral:
            result = fetch.ai_signature_of("/bin/fv", text, key)
        return result, calls, collateral

    def test_a_silent_advisor_needs_no_archive_and_makes_no_call(self):
        result, calls, _ = self.archive(decision(chat_id=""))
        self.assertIsNone(result)
        self.assertEqual(calls, [])

    def test_without_an_archive_key_nothing_is_fetched(self):
        result, calls, _ = self.archive(decision(), key=None)
        self.assertIsNone(result)
        self.assertEqual(calls, [])

    def test_the_signature_is_fetched_for_the_model_that_answered(self):
        _, calls, _ = self.archive(decision(m=1))
        url, headers = calls[0]
        self.assertIn(f"/v1/signature/{CHAT}?", url)
        self.assertEqual(dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query)),
                         {"model": fetch.MODELS[1], "signing_algo": "ecdsa"})
        self.assertEqual(headers["authorization"], f"Bearer {KEY}")

    def test_the_attestation_is_asked_with_the_reply_hash_as_its_nonce(self):
        _, calls, _ = self.archive(decision())
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(calls[1][0]).query))
        self.assertEqual(query, {"model": fetch.MODELS[0], "signing_algo": "ecdsa", "signing_address": SIGNER, "nonce": RESP})

    def test_the_archive_keeps_the_signature_and_the_signer_report(self):
        result, _, collateral = self.archive(decision())
        self.assertEqual(result["model"], fetch.MODELS[0])
        self.assertEqual(result["text"], f"{fetch.MODELS[0]}:{'ab' * 32}:{RESP}")
        self.assertEqual(result["signing_address"], SIGNER)
        self.assertEqual(result["report"], {"model_name": fetch.MODELS[0], "signing_address": SIGNER,
                                            "request_nonce": RESP, "intel_quote": "0400", "event_log": EVENTS})
        self.assertEqual(result["collateral"], {"tcb_info": "c"})
        collateral.assert_called_once_with("/bin/fv", bytes.fromhex("0400"))
        self.assertIsInstance(result["collateral_fetched_at"], int)

    def test_the_key_stays_out_of_the_archive(self):
        result, _, _ = self.archive(decision())
        self.assertNotIn(KEY, json.dumps(result))

    def test_a_signature_nearai_never_has_is_recorded_as_missing_after_retries(self):
        result, calls, _ = self.archive(decision(), signature_status=404)
        self.assertEqual(result, {"missing": "signature: HTTP 404"})
        self.assertEqual(len(calls), fetch.NEARAI_ATTEMPTS)

    def test_a_signature_that_appears_a_moment_later_is_archived(self):
        result, calls, _ = self.archive(decision(), signature_status=[404, 404, 200])
        self.assertEqual(result["signing_address"], SIGNER)
        self.assertEqual(len(calls), 4)

    def test_a_refused_key_is_recorded_without_blocking_the_proof(self):
        for status in (401, 403):
            with self.subTest(status=status):
                result, calls, _ = self.archive(decision(), signature_status=status)
                self.assertEqual(result, {"missing": f"signature: key refused (HTTP {status})"})
                self.assertEqual(len(calls), 1)

    def test_several_replicas_behind_one_signer_archive_the_first_report(self):
        result, _, collateral = self.archive(decision(), replicas=3)
        self.assertEqual(result["report"]["intel_quote"], "0400")
        self.assertEqual(result["report"]["signing_address"], SIGNER)
        collateral.assert_called_once_with("/bin/fv", bytes.fromhex("0400"))

    def test_a_report_with_no_entry_for_the_signer_is_a_source_error(self):
        with self.assertRaises(fetch.SourceError) as caught:
            self.archive(decision(), replicas=0)
        self.assertIn("no entry for signer", str(caught.exception))

    def test_a_malformed_reply_is_a_source_error(self):
        for signature in ({"text": "x"}, ["not", "an", "object"], {"text": "x", "signature": "s", "signing_algo": "ecdsa", "signing_address": 7}):
            with self.subTest(signature=signature), self.assertRaises(fetch.SourceError):
                self.archive(decision(), signature=signature)

    def test_a_report_quote_that_is_not_hex_is_a_source_error(self):
        calls = []
        world = nearai_world(calls)

        def bad_quote(url, body=None, headers=None):
            answer = world(url, body, headers)
            if "attestation" in url:
                answer["model_attestations"][1]["intel_quote"] = "zz"
            return answer

        with mock.patch.object(fetch, "read_json", side_effect=bad_quote), mock.patch.object(fetch.time, "sleep"), \
                self.assertRaises(fetch.SourceError):
            fetch.ai_signature_of("/bin/fv", decision(), KEY)

    def test_nearai_down_is_a_source_error_after_retries(self):
        with self.assertRaises(fetch.SourceError):
            self.archive(decision(), report_status=502)

    def test_a_decision_without_a_known_model_index_is_a_source_error(self):
        for m in (None, 2, -1, "0"):
            with self.subTest(m=m), self.assertRaises(fetch.SourceError):
                self.archive(decision(m=m))

    def test_the_models_match_the_strategy(self):
        source = (ROOT / "strategy" / "src" / "advisor.rs").read_text()
        line = next(l for l in source.splitlines() if "pub const MODELS" in l)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', line)), fetch.MODELS)

    def test_the_cycle_carries_the_archive_from_the_environment(self):
        cycle = {"tx": "T", "decision": decision()}
        with mock.patch.object(fetch, "ai_signature_of", return_value={"missing": "x"}) as archive, \
                mock.patch.dict(fetch.os.environ, {fetch.ARCHIVE_KEY_ENV: KEY}):
            fetch.add_ai_signature(cycle, "/bin/fv")
        archive.assert_called_once_with("/bin/fv", cycle["decision"], KEY)
        self.assertEqual(cycle["ai_signature"], {"missing": "x"})

    def test_a_cycle_without_an_archive_is_left_as_it_was(self):
        cycle = {"tx": "T", "decision": decision(chat_id="")}
        with mock.patch.object(fetch, "ai_signature_of", return_value=None):
            fetch.add_ai_signature(cycle, "/bin/fv")
        self.assertNotIn("ai_signature", cycle)


if __name__ == "__main__":
    unittest.main()
