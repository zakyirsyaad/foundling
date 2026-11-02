#!/usr/bin/env python3
"""Builds the proof file `foundling-verify check` reads, from public sources and with no keys.

Usage:
  python3 tools/fetch_proof.py --chain testnet --vault <account> --collateral-bin <binary> \
      --out <proof.json> [--reveal-tx <hash> --reveal-signer <account>] <trigger_tx> [<trigger_tx> ...]

The trigger transactions come from the keeper's history. The collateral binary is
`foundling-verify` built with `--features fetch`. Exit code 0 means the file was written,
2 means a source could not be read.
"""

import argparse
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

CHAINS = {
    "testnet": {
        "rpcs": ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
        "api": "https://testnet-api.outlayer.ai",
        "registry": "worker.outlayer.testnet",
    },
    "mainnet": {
        "rpcs": ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
        "api": "https://api.outlayer.ai",
        "registry": "worker.outlayer.near",
    },
}
ATTEMPTS = 6
TIMEOUT_SECONDS = 20
TOOL_FAILED = 2
EVENT_PREFIX = "EVENT_JSON:"
EMPTY_ARGS = base64.b64encode(b"{}").decode()


class SourceError(Exception):
    pass


def read_json(url, body=None):
    headers = {"content-type": "application/json", "user-agent": "foundling-verify"}
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def rpc(chain, method, params):
    rpcs = CHAINS[chain]["rpcs"]
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
    with tempfile.NamedTemporaryFile(suffix=".quote") as quote:
        quote.write(base64.b64decode(tdx_quote))
        quote.flush()
        done = subprocess.run([binary, "collateral", quote.name], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise SourceError(f"collateral: {done.stderr.strip()}")
    return json.loads(done.stdout)


def cycle_of(chain, vault, outlayer, keeper, binary, tx_hash):
    status = tx_status(chain, tx_hash, keeper)
    decisions = [data["decision"] for name, data in events_of(status, vault) if name == "decision"]
    if len(decisions) != 1:
        raise SourceError(f"tx {tx_hash} carries {len(decisions)} decisions")
    try:
        attestation = read_json(f"{CHAINS[chain]['api']}/attestations/by-tx/{tx_hash}")
    except urllib.error.HTTPError as error:
        raise SourceError(f"attestation of {tx_hash}: {error.code}") from error
    return {
        "tx": tx_hash,
        "input_data": input_data_of(status, vault, outlayer),
        "decision": decisions[0],
        "attestation": attestation,
        "collateral": collateral_of(binary, attestation["tdx_quote"]),
        "collateral_fetched_at": int(time.time()),
    }


def opening_of(chain, vault, tx_hash, signer):
    params = view(chain, vault, "revealed")
    if params is None:
        return None
    if not tx_hash:
        raise SourceError("the vault is revealed, so pass --reveal-tx and --reveal-signer")
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


def main():
    parser = argparse.ArgumentParser(description="Build a Foundling proof file from public sources.")
    parser.add_argument("--chain", choices=sorted(CHAINS), required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--collateral-bin", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reveal-tx")
    parser.add_argument("--reveal-signer")
    parser.add_argument("trigger_tx", nargs="+")
    args = parser.parse_args()
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
