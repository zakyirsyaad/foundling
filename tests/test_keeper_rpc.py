"""The keeper's RPC wrapper: retries across endpoints, with a fake transport and no network."""

import base64
import json
import unittest

from tools.keeper.rpc import RpcClient, RpcError, ViewError

A = "https://rpc-a.example"
B = "https://rpc-b.example"


class Transport:
    """Answers from a script, one entry per request. An exception entry is raised."""

    def __init__(self, *script):
        self.script = list(script)
        self.urls = []
        self.payloads = []

    def __call__(self, url, payload):
        self.urls.append(url)
        self.payloads.append(payload)
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def ok(result):
    return {"jsonrpc": "2.0", "id": "keeper", "result": result}


def rpc_error(name="TIMEOUT_ERROR"):
    return {"jsonrpc": "2.0", "id": "keeper", "error": {"name": name, "code": -32000}}


def view_result(value):
    return ok({"result": list(json.dumps(value).encode()), "logs": [], "block_height": 1})


class RetryTest(unittest.TestCase):
    def client(self, transport, **kw):
        self.sleeps = []
        return RpcClient([A, B], transport=transport, sleep=self.sleeps.append, **kw)

    def test_retries_rpc_error_across_endpoints(self):
        transport = Transport(OSError("reset"), rpc_error(), view_result({"ok": True}))
        value = self.client(transport).view("vault.test", "stage")
        self.assertEqual(value, {"ok": True})
        self.assertEqual(transport.urls, [A, B, A])

    def test_backs_off_between_attempts(self):
        transport = Transport(OSError("x"), OSError("x"), OSError("x"), view_result(1))
        self.client(transport, base_delay=1.0, max_delay=3.0).view("v", "m")
        self.assertEqual(self.sleeps, [1.0, 2.0, 3.0])

    def test_raises_after_the_last_attempt(self):
        transport = Transport(*[OSError("down")] * 4)
        with self.assertRaises(RpcError):
            self.client(transport, attempts=4).view("v", "m")
        self.assertEqual(len(transport.urls), 4)

    def test_needs_two_different_endpoints(self):
        with self.assertRaises(ValueError):
            RpcClient([A], transport=Transport())
        with self.assertRaises(ValueError):
            RpcClient([A, A], transport=Transport())

    def test_a_failing_view_is_not_retried(self):
        failure = ok({"error": "wasm execution failed: Smart contract panicked: NOT_IDLE", "logs": []})
        transport = Transport(failure)
        with self.assertRaises(ViewError):
            self.client(transport).view("v", "m")
        self.assertEqual(len(transport.urls), 1)


class RequestShapeTest(unittest.TestCase):
    def client(self, transport):
        return RpcClient([A, B], transport=transport, sleep=lambda s: None)

    def test_view_sends_finalized_call_function_with_base64_args(self):
        transport = Transport(view_result("Idle"))
        self.client(transport).view("vault.test", "stage", {"a": 1})
        params = transport.payloads[0]["params"]
        self.assertEqual(transport.payloads[0]["method"], "query")
        self.assertEqual(params["request_type"], "call_function")
        self.assertEqual(params["finality"], "final")
        self.assertEqual(params["account_id"], "vault.test")
        self.assertEqual(params["method_name"], "stage")
        self.assertEqual(json.loads(base64.b64decode(params["args_base64"])), {"a": 1})

    def test_a_view_can_be_pinned_to_a_block_height(self):
        transport = Transport(view_result("Idle"))
        self.client(transport).view("vault.test", "stage", block_id=4242)
        params = transport.payloads[0]["params"]
        self.assertEqual(params["block_id"], 4242)
        self.assertNotIn("finality", params)

    def test_a_node_that_lacks_the_pinned_block_is_retried_on_the_next_endpoint(self):
        transport = Transport(rpc_error("UNKNOWN_BLOCK"), view_result("Idle"))
        self.assertEqual(self.client(transport).view("v", "stage", block_id=9), "Idle")
        self.assertEqual(transport.urls, [A, B])

    def test_block_returns_height_and_seconds(self):
        header = {"header": {"height": 77, "timestamp": 1_700_000_005_900_000_000}}
        transport = Transport(ok(header))
        self.assertEqual(self.client(transport).block(), (77, 1_700_000_005))
        self.assertEqual(transport.payloads[0]["method"], "block")
        self.assertEqual(transport.payloads[0]["params"], {"finality": "final"})

    def test_tx_logs_collects_every_receipt_in_order(self):
        status = {
            "transaction_outcome": {"outcome": {"logs": ["a"]}},
            "receipts_outcome": [{"outcome": {"logs": ["b", "c"]}}, {"outcome": {"logs": []}}],
        }
        transport = Transport(ok(status))
        self.assertEqual(self.client(transport).tx_logs("HASH", "keeper.test"), ["a", "b", "c"])
        payload = transport.payloads[0]
        self.assertEqual(payload["method"], "EXPERIMENTAL_tx_status")
        self.assertEqual(
            payload["params"],
            {"tx_hash": "HASH", "sender_account_id": "keeper.test", "wait_until": "FINAL"},
        )


if __name__ == "__main__":
    unittest.main()
