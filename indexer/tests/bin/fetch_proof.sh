#!/bin/sh
# Stand-in for tools/fetch_proof.py. FAKE_FETCH: ok (default) | down (exit 2) | hang | garbage.
echo "fetch $*" >> "${FAKE_LOG:-/dev/null}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
case "${FAKE_FETCH:-ok}" in
  down) echo "source down" >&2; exit 2 ;;
  hang) sleep 30; exit 0 ;;
esac
opening=""
[ -n "$FAKE_OPENING" ] && opening=',"opening":{"params":"p","salt":"s"}'
[ "${FAKE_FETCH:-ok}" = "garbage" ] && { echo "not json" > "$out"; exit 0; }
# Real collateral ends its PCK certificate chain with a NUL, which jsonb refuses; the fake keeps one.
printf '{"chain":"testnet","vault":"v","approved_measurements":[{"mrtd":"aa"}],"cycles":[{"trigger_tx":"T","collateral":{"pck_certificate_chain":"-----END CERTIFICATE-----\\n\\u0000"}}]%s}\n' "$opening" > "$out"
