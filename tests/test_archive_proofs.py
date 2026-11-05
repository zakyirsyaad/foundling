"""archive_proofs.py against a local HTTP server standing in for the public API."""

import importlib.util
import io
import json
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("archive_proofs", ROOT / "tools" / "archive_proofs.py")
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)

VAULT = "vault.fdl-m12-0d1276.testnet"


class Fake:
    nonces = ["3", "2", "1"]
    proofs = {"1": {"verifier": None, "obs_recheck": None, "replay": "sealed", "bundle": {"pck": "x\u0000"}}, "3": {"verifier": None, "obs_recheck": None, "replay": "pass", "bundle": None}}


def envelope(data, cursor=None):
    return {"success": True, "data": data, "error": None, "meta": {"cursor": cursor}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/v1/cycles":
            # two pages of cycles
            cursor = parse_qs(url.query).get("cursor", [None])[0]
            rows = [{"nonce": n} for n in Fake.nonces]
            if cursor is None:
                return self.reply(200, envelope(rows[:2], "next"))
            return self.reply(200, envelope(rows[2:]))
        if url.path.startswith("/v1/proofs/"):
            nonce = url.path.rsplit("/", 1)[1]
            if nonce in Fake.proofs:
                return self.reply(200, envelope(Fake.proofs[nonce]))
            return self.reply(404, {"success": False, "data": None, "error": "no proof", "meta": None})
        self.reply(404, {"success": False, "data": None, "error": "not found", "meta": None})


class ArchiveProofs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.nonces = ["3", "2", "1"]
        self.out = Path(tempfile.mkdtemp())

    def run_archive(self, vault=VAULT):
        with redirect_stdout(io.StringIO()):
            return archive.main(["--api", self.base, "--vault", vault, "--out", str(self.out)])

    def test_writes_one_file_per_proof_across_pages_and_skips_missing_ones(self):
        self.assertEqual(self.run_archive(), 0)
        files = sorted(p.name for p in (self.out / VAULT).iterdir())
        self.assertEqual(files, ["1.json", "3.json"])
        saved = json.loads((self.out / VAULT / "1.json").read_text())
        self.assertEqual(saved["proof"]["bundle"], {"pck": "x\u0000"})
        self.assertEqual(saved["vault"], VAULT)
        self.assertEqual(saved["nonce"], "1")

    def test_a_second_run_leaves_unchanged_files_alone(self):
        self.run_archive()
        first = (self.out / VAULT / "1.json").stat().st_mtime_ns
        self.run_archive()
        self.assertEqual((self.out / VAULT / "1.json").stat().st_mtime_ns, first)

    def test_a_nonce_that_is_not_digits_is_refused(self):
        Fake.nonces = ["../../escape", "1"]
        self.assertEqual(self.run_archive(), 1)
        self.assertFalse((self.out.parent / "escape.json").exists())
        self.assertFalse(any(self.out.rglob("*escape*")))

    def test_a_bad_vault_id_is_refused(self):
        with self.assertRaises(SystemExit):
            self.run_archive("../evil")


if __name__ == "__main__":
    unittest.main()
