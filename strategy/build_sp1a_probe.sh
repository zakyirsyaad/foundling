#!/usr/bin/env bash
# Builds N WASM variants of the sp1a-probe bin, each with a new sha256 (cold start per
# run), the same way build.sh builds the strategy: paths remapped, locked lockfile, no
# stale output left over from a previous count.
# Usage: ./build_sp1a_probe.sh [count]   (default 10). Output: out/sp1a-probe-run-NN.wasm
set -euo pipefail
cd "$(dirname "$0")"

COUNT="${1:-10}"
if ! [[ "$COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "count must be a positive integer, got: $COUNT" >&2
  exit 1
fi

registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
export RUSTFLAGS="--remap-path-prefix=$registry=/cargo --remap-path-prefix=$PWD=/strategy"

rm -rf out
mkdir -p out
i=1
while [ "$i" -le "$COUNT" ]; do
  id=$(printf "run-%02d" "$i")
  SP1A_BUILD_ID="$id" cargo build --locked --release --target wasm32-wasip2 --bin sp1a-probe
  cp "target/wasm32-wasip2/release/sp1a-probe.wasm" "out/sp1a-probe-$id.wasm"
  i=$((i + 1))
done
shasum -a 256 out/sp1a-probe-run-*.wasm
