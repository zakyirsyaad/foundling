#!/bin/sh
# Stand-in for tools/recheck_obs.py. FAKE_RECHECK: ok (default) | fail (exit 1) | down (exit 2).
echo "recheck $*" >> "${FAKE_LOG:-/dev/null}"
[ -n "$FAKE_ENV_LOG" ] && echo "recheck key=${NEARAI_ARCHIVE_KEY:-none}" >> "$FAKE_ENV_LOG"
case "${FAKE_RECHECK:-ok}" in
  fail) echo "FAIL obs pb: off by 3%"; echo "SUMMARY pass=2 skip=0 fail=1"; exit 1 ;;
  down) echo "SKIP obs pb: kraken unreachable"; echo "SUMMARY pass=0 skip=3 fail=0"; exit 2 ;;
esac
echo "SUMMARY pass=3 skip=0 fail=0"
