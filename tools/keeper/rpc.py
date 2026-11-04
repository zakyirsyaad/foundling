"""JSON-RPC client for the keeper: retries across endpoints, no signing."""

import base64
import json
import time
import urllib.request


class RpcError(Exception):
    """The RPC could not answer after every attempt."""


class ViewError(RpcError):
    """The contract refused a view call. Asking again gets the same answer."""


def http_transport(url, payload, timeout=20):
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


class RpcClient:
    def __init__(self, endpoints, transport=http_transport, sleep=time.sleep,
                 attempts=6, base_delay=1.0, max_delay=30.0):
        if len(set(endpoints)) < 2:
            raise ValueError("at least two different RPC endpoints are required")
        self.endpoints = list(endpoints)
        self.transport = transport
        self.sleep = sleep
        self.attempts = attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self._next = 0

    def call(self, method, params):
        last = None
        for attempt in range(self.attempts):
            url = self.endpoints[self._next % len(self.endpoints)]
            self._next += 1
            payload = {"jsonrpc": "2.0", "id": "keeper", "method": method, "params": params}
            try:
                data = self.transport(url, payload)
                if "error" in data:
                    raise RpcError(f"{method}: {json.dumps(data['error'])[:200]}")
                return data["result"]
            except Exception as exc:  # rate limits, resets and node errors all retry
                last = exc
                if attempt + 1 < self.attempts:
                    self.sleep(min(self.base_delay * 2**attempt, self.max_delay))
        raise RpcError(f"{method} failed after {self.attempts} attempts: {last}")

    def view(self, account, method, args=None, block_id=None):
        """`block_id` pins the read to a height: a node that has not reached it errors and the
        call retries on the next endpoint, so two reads in one tick cannot straddle blocks."""
        raw = json.dumps(args or {}).encode()
        at = {"finality": "final"} if block_id is None else {"block_id": block_id}
        result = self.call("query", {
            "request_type": "call_function", **at, "account_id": account,
            "method_name": method, "args_base64": base64.b64encode(raw).decode(),
        })
        if "error" in result:
            raise ViewError(f"{account}.{method}: {str(result['error'])[:200]}")
        return json.loads(bytes(result["result"]))

    def block(self):
        header = self.call("block", {"finality": "final"})["header"]
        return header["height"], header["timestamp"] // 10**9

    def tx_logs(self, tx_hash, signer):
        status = self.call("EXPERIMENTAL_tx_status", {
            "tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL"})
        outcomes = [status["transaction_outcome"], *status["receipts_outcome"]]
        return [log for item in outcomes for log in item["outcome"]["logs"]]
