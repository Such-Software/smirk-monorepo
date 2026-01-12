#!/bin/bash
set -e

echo "Building smirk-wasm..."

# Build WASM
cargo build --target wasm32-unknown-unknown --release

# Generate JS bindings
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/smirk_wasm.wasm

# Show output
echo ""
echo "Build complete!"
ls -lh pkg/
