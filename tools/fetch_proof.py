#!/usr/bin/env python3
"""Builds the proof file `foundling-verify check` reads, from public sources and with no keys.

Usage:
  python3 tools/fetch_proof.py --chain testnet --vault <account> --collateral-bin <binary> \
      --out <proof.json> [--rpc <url> ...] [--reveal-tx <hash> --reveal-signer <account>] <trigger_tx> [<trigger_tx> ...]

`--rpc`, repeatable, replaces the chain's RPC list in order; pass archival nodes for transactions
older than regular nodes keep (about 17 to 20 hours). For a revealed vault the opening is read
from the `revealed` and `revealed_salt` views, unless `--reveal-tx` asks for the log instead.

The trigger transactions come from the keeper's history. The collateral binary is
`foundling-verify` built with `--features fetch`. Exit code 0 means the file was written,
2 means a source could not be read.

When the cycle's decision names a NEAR AI chat (`ai_ref.chat_id`) and NEARAI_ARCHIVE_KEY is set, the
model's signature for that reply and the signer's attestation report are fetched and kept in the
cycle as `ai_signature`. Both endpoints need a key, and the key sealed in the vault never leaves it,
so this second key (same NEAR AI account) is how a reader without one can still check the reply. The
key goes only into the request header and is never written to the file.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

CHAINS = {
    "testnet": {
        "rpcs": ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
        "api": "https://testnet-api.outlayer.ai",
        "registry": "worker.outlayer.testnet",
    },
    "mainnet": {
        "rpcs": ["https://free.rpc.fastnear.com", "https://near.drpc.org"],
        "api": "https://api.outlayer.ai",
        "registry": "worker.outlayer.near",
    },
}
ATTEMPTS = 6
TIMEOUT_SECONDS = 20
TOOL_FAILED = 2
EVENT_PREFIX = "EVENT_JSON:"
EMPTY_ARGS = base64.b64encode(b"{}").decode()
NEARAI = "https://cloud-api.near.ai/v1"
ARCHIVE_KEY_ENV = "NEARAI_ARCHIVE_KEY"
# The strategy's `advisor::MODELS`, in order: `ai_ref.m` indexes it. A test keeps the two the same.
MODELS = ("z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B")
NOT_FOUND = 404
REFUSED = (401, 403)
# The worker asks seconds after the cycle; a signature NEAR AI has not stored yet answers 404 at first.
NEARAI_ATTEMPTS = 5
NEARAI_WAIT_SECONDS = 2
# `event_log` lets the verifier replay RTMR3 and read the app id dstack measured.
REPORT_FIELDS = ("model_name", "signing_address", "request_nonce", "intel_quote", "event_log")


class SourceError(Exception):
    pass


class Unarchivable(Exception):
    """NEAR AI will not give this record (gone, or the key is refused): kept as `missing`, not retried,
    so the rest of the proof is not held up by it."""


ACTIVE_RPCS = None


def use_rpcs(urls):
    """Replaces every chain's RPC list with `urls`, in order; None goes back to the defaults."""
    global ACTIVE_RPCS
    ACTIVE_RPCS = list(urls) if urls else None


def read_json(url, body=None, headers=None):
    headers = {"content-type": "application/json", "user-agent": "foundling-verify", **(headers or {})}
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def rpc(chain, method, params):
    rpcs = ACTIVE_RPCS or CHAINS[chain]["rpcs"]
    body = json.dumps({"jsonrpc": "2.0", "id": "foundling", "method": method, "params": params}).encode()
    last = None
    for attempt in range(ATTEMPTS):
        try:
            reply = read_json(rpcs[attempt % len(rpcs)], body)
        except OSError as error:  # rate limits and network errors clear up on another host
            last = error
            time.sleep(1 + attempt)
            continue
        if "result" in reply:
            return reply["result"]
        last = reply.get("error")
    raise SourceError(f"{method}: {last}")


def view(chain, account, method):
    params = {"request_type": "call_function", "finality": "final", "account_id": account,
              "method_name": method, "args_base64": EMPTY_ARGS}
    result = rpc(chain, "query", params)
    if "result" not in result:
        raise SourceError(f"{account}.{method}: {result.get('error')}")
    return json.loads(bytes(result["result"]))


def tx_status(chain, tx_hash, signer):
    return rpc(chain, "EXPERIMENTAL_tx_status",
               {"tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"})


def events_of(status, vault):
    for outcome in status["receipts_outcome"]:
        if outcome["outcome"]["executor_id"] != vault:
            continue
        for line in outcome["outcome"]["logs"]:
            if line.startswith(EVENT_PREFIX):
                event = json.loads(line[len(EVENT_PREFIX):])
                yield event["event"], event["data"][0]


def input_data_of(status, vault, outlayer):
    for receipt in status.get("receipts", []):
        if receipt["predecessor_id"] != vault or receipt["receiver_id"] != outlayer:
            continue
        for action in receipt["receipt"].get("Action", {}).get("actions", []):
            call = action.get("FunctionCall", {}) if isinstance(action, dict) else {}
            if call.get("method_name") == "request_execution":
                return json.loads(base64.b64decode(call["args"]))["input_data"]
    raise SourceError(f"no request_execution in tx {status['transaction']['hash']}")


def collateral_of(binary, tdx_quote):
    return collateral_of_bytes(binary, base64.b64decode(tdx_quote))


def collateral_of_bytes(binary, raw_quote):
    with tempfile.NamedTemporaryFile(suffix=".quote") as quote:
        quote.write(raw_quote)
        quote.flush()
        done = subprocess.run([binary, "collateral", quote.name], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise SourceError(f"collateral: {done.stderr.strip()}")
    return json.loads(done.stdout)


def nearai_get(what, path, query, key):
    """One NEAR AI record, asked up to NEARAI_ATTEMPTS times. A refused key, or a 404 to the last
    attempt, is Unarchivable; any other failure to the last attempt is a SourceError."""
    url = f"{NEARAI}{path}?{urllib.parse.urlencode(query)}"
    last, gone = "", False
    for attempt in range(NEARAI_ATTEMPTS):
        if attempt:
            time.sleep(NEARAI_WAIT_SECONDS * attempt)
        try:
            return read_json(url, headers={"authorization": f"Bearer {key}"})
        except urllib.error.HTTPError as error:
            if error.code in REFUSED:
                raise Unarchivable(f"{what}: key refused (HTTP {error.code})") from None
            last, gone = f"{what}: HTTP {error.code}", error.code == NOT_FOUND
        except (OSError, ValueError) as error:  # network, timeout, or a reply that is not JSON
            last, gone = f"{what}: {type(error).__name__}", False
    if gone:
        raise Unarchivable(last)
    raise SourceError(f"NEAR AI {last}")


def ai_signature_of(binary, decision_text, key):
    """The archive for one decision, None when there is nothing to archive or no key to do it with."""
    ai = json.loads(decision_text).get("ai_ref") or {}
    chat_id = ai.get("chat_id")
    if not chat_id or not key:
        return None
    index = ai.get("m")
    if type(index) is not int or not 0 <= index < len(MODELS):
        raise SourceError(f"chat {chat_id} names no model the advisor asks (m={index!r})")
    try:
        return archive_of(binary, chat_id, MODELS[index], ai["resp_sig_hash"], key)
    except Unarchivable as reason:
        return {"missing": str(reason)}
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise SourceError(f"NEAR AI reply for chat {chat_id} is malformed ({type(error).__name__}: {error})") from None


def archive_of(binary, chat_id, model, reply_hash, key):
    signature = nearai_get("signature", f"/signature/{chat_id}", {"model": model, "signing_algo": "ecdsa"}, key)
    signer = signature["signing_address"]
    # The reply hash as the nonce: the report then shows it was made after this reply existed.
    query = {"model": model, "signing_algo": "ecdsa", "signing_address": signer, "nonce": reply_hash}
    report = nearai_get("attestation report", "/attestation/report", query, key)
    entries = [e for e in report["model_attestations"] if e["signing_address"].lower() == signer.lower()]
    if len(entries) != 1:
        raise SourceError(f"the attestation report has {len(entries)} entries for signer {signer}")
    entry = {field: entries[0][field] for field in REPORT_FIELDS}
    if isinstance(entry["event_log"], str):
        entry["event_log"] = json.loads(entry["event_log"])
    return {
        "model": model,
        "text": signature["text"],
        "signature": signature["signature"],
        "signing_address": signer,
        "signing_algo": signature["signing_algo"],
        "report": entry,
        "collateral": collateral_of_bytes(binary, bytes.fromhex(entry["intel_quote"])),
        "collateral_fetched_at": int(time.time()),
    }


def add_ai_signature(cycle, binary):
    archive = ai_signature_of(binary, cycle["decision"], os.environ.get(ARCHIVE_KEY_ENV))
    if archive is not None:
        cycle["ai_signature"] = archive


def cycle_of(chain, vault, outlayer, keeper, binary, tx_hash):
    status = tx_status(chain, tx_hash, keeper)
    decisions = [data["decision"] for name, data in events_of(status, vault) if name == "decision"]
    if len(decisions) != 1:
        raise SourceError(f"tx {tx_hash} carries {len(decisions)} decisions")
    try:
        attestation = read_json(f"{CHAINS[chain]['api']}/attestations/by-tx/{tx_hash}")
    except urllib.error.HTTPError as error:
        raise SourceError(f"attestation of {tx_hash}: {error.code}") from error
    cycle = {
        "tx": tx_hash,
        "input_data": input_data_of(status, vault, outlayer),
        "decision": decisions[0],
        "attestation": attestation,
        "collateral": collateral_of(binary, attestation["tdx_quote"]),
        "collateral_fetched_at": int(time.time()),
    }
    add_ai_signature(cycle, binary)
    return cycle


def opening_of(chain, vault, tx_hash, signer):
    params = view(chain, vault, "revealed")
    if params is None:
        return None
    if not tx_hash:
        salt = view(chain, vault, "revealed_salt")
        if salt is None:
            raise SourceError(f"{vault} is revealed but its revealed_salt view is empty")
        return {"params": params, "salt": salt}
    status = tx_status(chain, tx_hash, signer)
    salts = [data["salt"] for name, data in events_of(status, vault) if name == "revealed"]
    if len(salts) != 1:
        raise SourceError(f"tx {tx_hash} is not the reveal of {vault}")
    return {"params": params, "salt": salts[0]}


def build(args):
    chain, vault = args.chain, args.vault
    agent = view(chain, vault, "agent")
    if agent["chain"] != chain:
        raise SourceError(f"{vault} says its chain is {agent['chain']}")
    keeper = view(chain, vault, "roles")["keeper"]
    proof = {
        "chain": chain,
        "vault": vault,
        "wasm_hash": agent["wasm_hash"],
        "commitment": agent["commitment"],
        "secrets_ref": f"{agent['secrets_owner']}/{agent['secrets_profile']}",
        "approved_measurements": view(chain, CHAINS[chain]["registry"], "get_approved_measurements"),
        "cycles": [cycle_of(chain, vault, agent["outlayer"], keeper, args.collateral_bin, tx_hash)
                   for tx_hash in args.trigger_tx],
    }
    opening = opening_of(chain, vault, args.reveal_tx, args.reveal_signer)
    if opening:
        proof["opening"] = opening
    return proof


def build_parser():
    parser = argparse.ArgumentParser(description="Build a Foundling proof file from public sources.")
    parser.add_argument("--chain", choices=sorted(CHAINS), required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--collateral-bin", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reveal-tx")
    parser.add_argument("--reveal-signer")
    parser.add_argument("--rpc", action="append", help="RPC URL, repeatable; replaces the chain's list in order")
    parser.add_argument("trigger_tx", nargs="+")
    return parser


def main():
    args = build_parser().parse_args()
    use_rpcs(args.rpc)
    try:
        proof = build(args)
    except (SourceError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(TOOL_FAILED)
    with open(args.out, "w") as out:
        json.dump(proof, out, indent=1, sort_keys=True)
        out.write("\n")
    print(f"{args.out}: {len(proof['cycles'])} cycles, opening {'yes' if 'opening' in proof else 'no'}")


if __name__ == "__main__":
    main()
