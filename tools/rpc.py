"""Read-only testnet RPC helper for SP9 (no signing).

Usage:
  python3 tools/rpc.py keys <account>
  python3 tools/rpc.py key <account> <public_key>
  python3 tools/rpc.py view <contract> <method> [json_args]
  python3 tools/rpc.py tx <tx_hash> <signer>
"""

import base64
import hashlib
import json
import sys
import time
import urllib.request

RPCS = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]


def call(method, params):
    last = None
    for attempt in range(6):
        url = RPCS[attempt % len(RPCS)]
        body = json.dumps({"jsonrpc": "2.0", "id": "sp9", "method": method, "params": params}).encode()
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "foundling-tools"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            if "error" in data:
                return {"error": data["error"]}
            return data["result"]
        except Exception as exc:  # retry on rate limits and network errors
            last = exc
            time.sleep(1 + attempt)
    raise RuntimeError(f"RPC failed: {last}")


def query(request_type, **kw):
    return call("query", {"request_type": request_type, "finality": "final", **kw})


def main():
    cmd, *args = sys.argv[1:]
    if cmd == "keys":
        res = query("view_access_key_list", account_id=args[0])
        print(json.dumps(res.get("keys", res), indent=1))
    elif cmd == "key":
        print(json.dumps(query("view_access_key", account_id=args[0], public_key=args[1]), indent=1))
    elif cmd == "view":
        raw = (args[2] if len(args) > 2 else "{}").encode()
        res = query("call_function", account_id=args[0], method_name=args[1],
                    args_base64=base64.b64encode(raw).decode())
        print(bytes(res["result"]).decode() if "result" in res else json.dumps(res))
    elif cmd == "tx":
        res = call("EXPERIMENTAL_tx_status", {"tx_hash": args[0], "sender_account_id": args[1],
                                              "wait_until": "FINAL"})
        tx = res["transaction"]
        print("signer", tx["signer_id"], "receiver", tx["receiver_id"], "public_key", tx["public_key"])
        for action in tx["actions"]:
            if isinstance(action, dict) and "FunctionCall" in action:
                fc = action["FunctionCall"]
                args_bytes = base64.b64decode(fc["args"])
                print("action FunctionCall", fc["method_name"], "deposit", fc["deposit"],
                      "args_sha256", hashlib.sha256(args_bytes).hexdigest(), "args", args_bytes.decode()[:200])
            elif isinstance(action, dict) and "DeployContract" in action:
                # The RPC view shows the 32-byte code hash, not the code itself.
                code_hash = base64.b64decode(action["DeployContract"]["code"])
                print("action DeployContract code_sha256", code_hash.hex())
            else:
                print("action", json.dumps(action)[:200])
        print("status", json.dumps(res["status"])[:400])
        for ro in [res["transaction_outcome"], *res["receipts_outcome"]]:
            out = ro["outcome"]
            print("outcome", ro["id"][:10], out["executor_id"], "gas_burnt", out["gas_burnt"],
                  "tokens_burnt", out["tokens_burnt"], json.dumps(out["status"])[:200])
            for log in out["logs"]:
                print("   log", log)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
