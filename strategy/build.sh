#!/usr/bin/env bash
# The one recipe for the strategy WASM. Paths are remapped so the same source gives the
# same hash from any folder, and no local path ends up in a public binary.
# Extra arguments go to cargo, for example: ./build.sh --features rehearsal
set -euo pipefail
cd "$(dirname "$0")"

registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
export RUSTFLAGS="--remap-path-prefix=$registry=/cargo --remap-path-prefix=$PWD=/strategy"
cargo build --locked --release --target wasm32-wasip2 "$@"
shasum -a 256 target/wasm32-wasip2/release/foundling-strategy.wasm
