#!/usr/bin/env python3
"""Checks the worker from outside the VPS: a fresh heartbeat on the public API, and a keeper with NEAR to spend.

Usage:
  python3 tools/heartbeat_check.py --api https://api.foundling.xyz --keeper <account> --min-near 2 \
      [--rpc https://rpc.mainnet.fastnear.com]

Exit 0 when both hold, 1 when either fails or cannot be read. Every problem is printed on its own line,
so a failed scheduled run explains itself in the GitHub email.
"""

import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.request
from decimal import Decimal

MAX_HEARTBEAT_AGE = datetime.timedelta(minutes=10)
YOCTO_PER_NEAR = 10**24
TIMEOUT_SECONDS = 15
ACCOUNT_ID = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")
DEFAULT_RPC = "https://rpc.mainnet.fastnear.com"


def http_json(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers={"content-type": "application/json", "accept": "application/json", "user-agent": "foundling-heartbeat"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def heartbeat_problem(api, now):
    try:
        envelope = http_json(f"{api}/v1/status")
    except urllib.error.HTTPError as error:
        return f"API {api}/v1/status answered HTTP {error.code}"
    except (OSError, ValueError) as error:
        return f"API {api}/v1/status could not be read: {error}"
    stamp = (envelope.get("data") or {}).get("heartbeat_at")
    if not envelope.get("success") or not isinstance(stamp, str):
        return f"API {api}/v1/status has no heartbeat: {envelope.get('error')}"
    at = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    age = now - at
    if age > MAX_HEARTBEAT_AGE:
        return f"worker heartbeat is {int(age.total_seconds() // 60)} minutes old (limit {int(MAX_HEARTBEAT_AGE.total_seconds() // 60)})"
    return None


def keeper_problem(rpc, keeper, min_near):
    body = {"jsonrpc": "2.0", "id": "heartbeat", "method": "query",
            "params": {"request_type": "view_account", "finality": "final", "account_id": keeper}}
    try:
        reply = http_json(rpc, body)
    except (OSError, ValueError) as error:
        return f"RPC {rpc} could not read {keeper}: {error}"
    if "result" not in reply:
        return f"RPC {rpc} could not read {keeper}: {reply.get('error')}"
    balance = Decimal(int(reply["result"]["amount"])) / YOCTO_PER_NEAR
    if balance < min_near:
        return f"keeper {keeper} holds {balance.normalize()} NEAR, below {min_near.normalize()}"
    return None


def parse(argv):
    parser = argparse.ArgumentParser(description="Outside check of the Foundling worker and keeper.")
    parser.add_argument("--api", required=True, help="public API origin, https")
    parser.add_argument("--keeper", required=True)
    parser.add_argument("--min-near", required=True, type=Decimal)
    parser.add_argument("--rpc", default=DEFAULT_RPC)
    args = parser.parse_args(argv)
    for name in ("api", "rpc"):
        if not re.match(r"^https?://", getattr(args, name)):
            parser.error(f"--{name} must be an http(s) URL")
    if not ACCOUNT_ID.match(args.keeper):
        parser.error("--keeper is not a NEAR account id")
    args.api = args.api.rstrip("/")
    return args


def main(argv=None):
    args = parse(argv if argv is not None else sys.argv[1:])
    now = datetime.datetime.now(datetime.timezone.utc)
    problems = [p for p in (heartbeat_problem(args.api, now), keeper_problem(args.rpc, args.keeper, args.min_near)) if p]
    for problem in problems:
        print(f"FAIL {problem}")
    if not problems:
        print(f"OK heartbeat fresh, keeper {args.keeper} above {args.min_near.normalize()} NEAR")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
