#!/usr/bin/env python3
"""Copies every proof the public API holds for one vault into files, for the `live-proofs` branch.

Usage:
  python3 tools/archive_proofs.py --api https://api.foundling.xyz --vault <account> --out proofs/live

Writes <out>/<vault>/<nonce>.json for each cycle that has a proof, and leaves unchanged files alone.
The bundle is the one record the chain cannot give back (WEBSITE §5), so it is kept outside the VPS.
Exit 0 on success, 1 when the API answers something unsafe or cannot be read.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TIMEOUT_SECONDS = 20
MAX_PAGES = 1000
ACCOUNT_ID = re.compile(r"^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")
NONCE = re.compile(r"^\d{1,20}$")


class ApiError(Exception):
    pass


def get(url):
    request = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "foundling-live-proofs"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise ApiError(f"{url} answered HTTP {error.code}")
    except (OSError, ValueError) as error:
        raise ApiError(f"{url} could not be read: {error}")


def nonces(api):
    cursor, found = None, []
    for _ in range(MAX_PAGES):
        query = urllib.parse.urlencode({"limit": 100, **({"cursor": cursor} if cursor else {})})
        page = get(f"{api}/v1/cycles?{query}")
        if not page or not page.get("success"):
            raise ApiError("the cycle list is missing")
        for row in page["data"]:
            nonce = row.get("nonce")
            if not isinstance(nonce, str) or not NONCE.match(nonce):
                raise ApiError(f"the API gave a nonce that is not a number: {nonce!r}")
            found.append(nonce)
        cursor = (page.get("meta") or {}).get("cursor")
        if not cursor:
            return found
    raise ApiError("the cycle list did not end")


def write_if_changed(path, record):
    text = json.dumps(record, indent=1, sort_keys=True) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.write_text(text)
    return True


def parse(argv):
    parser = argparse.ArgumentParser(description="Archive a vault's proofs from the public API.")
    parser.add_argument("--api", required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if not ACCOUNT_ID.match(args.vault) or len(args.vault) > 64:
        parser.error("--vault is not a NEAR account id")
    if not re.match(r"^https?://", args.api):
        parser.error("--api must be an http(s) URL")
    args.api = args.api.rstrip("/")
    return args


def main(argv=None):
    args = parse(argv if argv is not None else sys.argv[1:])
    folder = Path(args.out) / args.vault
    folder.mkdir(parents=True, exist_ok=True)
    try:
        written = 0
        for nonce in nonces(args.api):
            proof = get(f"{args.api}/v1/proofs/{nonce}")
            if proof is None:
                continue
            if not proof.get("success"):
                raise ApiError(f"proof {nonce}: {proof.get('error')}")
            written += write_if_changed(folder / f"{nonce}.json", {"vault": args.vault, "nonce": nonce, "proof": proof["data"]})
    except ApiError as error:
        print(f"FAIL {error}")
        return 1
    print(f"{args.vault}: {written} proof files written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
