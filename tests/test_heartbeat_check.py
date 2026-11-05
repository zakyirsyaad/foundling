"""heartbeat_check.py against a local HTTP server standing in for the API and the RPC."""

import datetime
import importlib.util
import io
import json
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("heartbeat_check", ROOT / "tools" / "heartbeat_check.py")
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

YOCTO = 10**24


class Fake:
    heartbeat_age_minutes = 1
    indexed_age_minutes = 1
    keeper_yocto = 5 * YOCTO
    api_up = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/v1/status" or not Fake.api_up:
            return self.reply(503, {"success": False, "data": None, "error": "busy", "meta": None})
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp = lambda minutes: (now - datetime.timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
        self.reply(200, {"success": True, "error": None, "meta": None,
                         "data": {"position": "10", "heartbeat_at": stamp(Fake.heartbeat_age_minutes), "tip_lag": "0",
                                  "indexed_at": stamp(Fake.indexed_age_minutes)}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        assert body["method"] == "query" and body["params"]["request_type"] == "view_account", body
        self.reply(200, {"jsonrpc": "2.0", "id": body["id"], "result": {"amount": str(Fake.keeper_yocto), "locked": "0"}})


class HeartbeatCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.heartbeat_age_minutes, Fake.indexed_age_minutes, Fake.keeper_yocto, Fake.api_up = 1, 1, 5 * YOCTO, True

    def run_check(self, *extra):
        out = io.StringIO()
        with redirect_stdout(out):
            code = check.main(["--api", self.base, "--rpc", self.base, "--keeper", "keeper.near", "--min-near", "2", *extra])
        return code, out.getvalue()

    def test_all_healthy_is_0(self):
        code, out = self.run_check()
        self.assertEqual(code, 0, out)
        self.assertIn("OK", out)

    def test_a_heartbeat_11_minutes_old_is_1(self):
        Fake.heartbeat_age_minutes = 11
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("heartbeat", out)

    def test_rounds_that_keep_failing_are_1_even_with_a_fresh_heartbeat(self):
        Fake.indexed_age_minutes = 25
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("last successful index round", out)

    def test_a_keeper_below_the_minimum_is_1(self):
        Fake.keeper_yocto = 15 * YOCTO // 10
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("keeper.near", out)
        self.assertIn("1.5", out)

    def test_an_api_that_is_down_is_1_with_a_clear_message(self):
        Fake.api_up = False
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("API", out)
        self.assertIn("503", out)

    def test_an_api_nobody_answers_is_1(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = check.main(["--api", "http://127.0.0.1:9", "--rpc", self.base, "--keeper", "keeper.near", "--min-near", "2"])
        self.assertEqual(code, 1)
        self.assertIn("API", out.getvalue())

    def test_bad_arguments_are_refused(self):
        with self.assertRaises(SystemExit):
            check.main(["--api", "ftp://x", "--rpc", self.base, "--keeper", "keeper.near", "--min-near", "2"])
        with self.assertRaises(SystemExit):
            check.main(["--api", self.base, "--rpc", self.base, "--keeper", "Not Valid", "--min-near", "2"])


if __name__ == "__main__":
    unittest.main()
