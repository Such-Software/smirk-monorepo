#!/bin/bash
# Standalone build script for the smirk-wasm WASM bundle.
# Prefer `make wasm` from the monorepo root for normal development —
# this script exists for backward compatibility and CI snippets that
# reference it directly.

set -euo pipefail

# Find the monorepo root (where Cargo.toml has [workspace])
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${WORKSPACE_ROOT}"

echo "Building smirk-wasm from ${WORKSPACE_ROOT}..."

# Build to wasm32 target — output lands in shared workspace target/
cargo build -p smirk-wasm --target wasm32-unknown-unknown --release

# Generate JS bindings — pkg/ lives next to the crate
wasm-bindgen --target no-modules \
  --out-dir "${SCRIPT_DIR}/pkg" \
  "${WORKSPACE_ROOT}/target/wasm32-unknown-unknown/release/smirk_wasm.wasm"

# Patches the no-modules output: (1) replaces broken `require("env")`
# C-import placeholders with no-op stubs (never invoked in our paths per
# secp256k1zkp/wasm-sysroot/README.md), (2) appends `export { wasm_bindgen };`
# so @smirk/wasm can import the IIFE-bound symbol as ESM.
node "${SCRIPT_DIR}/postprocess.mjs"

echo ""
echo "Build complete!"
ls -lh "${SCRIPT_DIR}/pkg/"
