#!/bin/sh
# Stand-in for foundling-verify. FAKE_VERIFY: ok (default) | nosummary | hang.
echo "verify $*" >> "${FAKE_LOG:-/dev/null}"
case "${FAKE_VERIFY:-ok}" in
  nosummary) echo "thread main panicked"; exit 0 ;;
  hang) sleep 30; exit 0 ;;
esac
if grep -q '"opening"' "$2"; then echo "PASS cycle 1 replay"; echo "SUMMARY pass=7 skip=0 fail=0"; else echo "SKIP cycle 1 replay: needs the revealed parameters"; echo "SUMMARY pass=6 skip=1 fail=0"; fi
