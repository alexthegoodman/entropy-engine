#!/usr/bin/env bash
# Builds the browser package: the engine as WebAssembly (src/script and the Rhai apps compiled
# into it) plus web/index.html and web/main.js. Serve web/ over HTTP and open it in a browser with
# WebGPU (index.html?app=nebula-kingdom, or ?app=hello).
#
# Needs: rustup target add wasm32-unknown-unknown, and wasm-bindgen-cli at the version in
# Cargo.lock (cargo install wasm-bindgen-cli --version <it> --locked). With --regenerate it first
# re-translates Nebula Kingdom from its TypeScript (needs node and examples/studio-bundle's npm
# install, for the TypeScript compiler).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--regenerate" ]]; then
    node scripts/ts2rhai.mjs examples/rhai/nebula_kingdom/ts2rhai.json
fi

want=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [[ "$have" != "$want" ]]; then
    echo "wasm-bindgen-cli $want is needed (found ${have:-none}): cargo install wasm-bindgen-cli --version $want --locked" >&2
    exit 1
fi

cargo rustc --lib --target wasm32-unknown-unknown --profile web --crate-type cdylib
wasm-bindgen --target web --no-typescript --out-dir web/pkg target/wasm32-unknown-unknown/web/entropy_engine.wasm
if command -v wasm-opt >/dev/null; then
    wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int web/pkg/entropy_engine_bg.wasm -o web/pkg/entropy_engine_bg.wasm
fi
ls -la web/pkg
echo "Built web/. Serve it, e.g.: python3 -m http.server -d web 8080  ->  http://localhost:8080/?app=nebula-kingdom"
