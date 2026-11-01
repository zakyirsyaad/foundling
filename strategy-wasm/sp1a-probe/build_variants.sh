#!/bin/sh
# Builds N WASM variants that differ only in BUILD_ID, so each has a new sha256 (cold start per run).
# Usage: sh build_variants.sh [count]   (default 10). Output: out/sp1a-probe-<id>.wasm
set -e
cd "$(dirname "$0")"
COUNT="${1:-10}"
mkdir -p out
i=1
while [ "$i" -le "$COUNT" ]; do
  ID=$(printf "run-%02d" "$i")
  SP1A_BUILD_ID="$ID" cargo build --target wasm32-wasip2 --release -q
  cp target/wasm32-wasip2/release/sp1a-probe.wasm "out/sp1a-probe-$ID.wasm"
  i=$((i + 1))
done
shasum -a 256 out/sp1a-probe-run-*.wasm
