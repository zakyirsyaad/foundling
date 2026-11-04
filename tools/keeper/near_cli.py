"""Signs and sends keeper calls through near-cli-rs. The key file is a path handed to the
CLI and is never opened here, and nothing the CLI prints is kept without `scrub`."""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass

TX_ID = re.compile(r"Transaction ID: ([A-Za-z0-9]+)")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
KEY_TOKEN = re.compile(r"(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{20,}")
KEY_FIELD = re.compile(r'("(?:private_key|secret_key|seed_phrase)"\s*:\s*)"[^"]*"')
MAX_ERROR = 300


@dataclass
class CallResult:
    ok: bool
    tx_hash: str | None = None
    error: str | None = None


class NearCliError(Exception):
    """near-cli could not be started at all."""


def scrub(text, key_file=None):
    text = ANSI.sub("", text)
    if key_file:
        # near-cli may print a relative path in its absolute form.
        for path in sorted({os.path.abspath(key_file), key_file}, key=len, reverse=True):
            text = text.replace(path, "<key-file>")
    text = KEY_FIELD.sub(r'\1"<redacted>"', text)
    return KEY_TOKEN.sub("<redacted-key>", text)


def run_subprocess(argv, timeout):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise NearCliError("the near CLI was not found on PATH") from None
    return done.returncode, done.stdout + done.stderr


def _partial_output(exc):
    parts = [exc.output, exc.stderr]
    return "".join(p.decode(errors="replace") if isinstance(p, bytes) else p or "" for p in parts)


def _error_text(output):
    # near-cli prints the failure after "Error:"; the trace lines below it add nothing.
    lines = output.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith("Error:")), 0)
    kept = [l for l in lines[start:] if not l.startswith(("Location:", "Error:")) and l.strip()]
    first = lines[start].removeprefix("Error:").strip() if lines else ""
    return " ".join([first, *kept] if first else kept)[:MAX_ERROR]


class NearCli:
    # Longer than the OutLayer yield window of about 146 s, which near-cli waits through.
    def __init__(self, signer, key_file, network="testnet", runner=run_subprocess, timeout=240):
        self.signer = signer
        self.key_file = key_file
        self.network = network
        self.runner = runner
        self.timeout = timeout

    def argv(self, contract, method, args, gas_tgas):
        return [
            "near", "contract", "call-function", "as-transaction", contract, method,
            "json-args", json.dumps(args), "prepaid-gas", f"{gas_tgas} Tgas",
            "attached-deposit", "0 NEAR", "sign-as", self.signer,
            "network-config", self.network,
            "sign-with-access-key-file", self.key_file, "send",
        ]

    def call(self, contract, method, args, gas_tgas):
        try:
            code, output = self.runner(self.argv(contract, method, args, gas_tgas), self.timeout)
        except TimeoutError:
            return CallResult(False, None, "timeout: the transaction may still have landed")
        except subprocess.TimeoutExpired as exc:
            seen = TX_ID.search(scrub(_partial_output(exc), self.key_file))
            return CallResult(False, seen.group(1) if seen else None,
                              "timeout: the transaction may still have landed")
        output = scrub(output, self.key_file)
        match = TX_ID.search(output)
        if match and code == 0:
            return CallResult(True, match.group(1))
        return CallResult(False, match.group(1) if match else None, _error_text(output))
