# Smirk Monorepo build orchestration.
#
# Cross-language build commands. See MONOREPO.md for layout details.

.PHONY: help build test check clean wasm wasm-node wasm-smoke rust-build \
        rust-test rust-check ts-build ts-test ts-typecheck ts-install \
        wasm-clean rust-clean ts-clean ext-chrome ext-firefox

# Default target — show help
help:
	@echo "Smirk monorepo make targets:"
	@echo ""
	@echo "  make build       Build everything (Rust crates, WASM bundle, TS packages)"
	@echo "  make test        Run all tests (cargo test --workspace + npm test)"
	@echo "  make check       Fast type/lint check without producing binaries"
	@echo "  make wasm        Build only the smirk-wasm WASM bundle"
	@echo "  make clean       Remove all build outputs (target/, pkg/, dist/, node_modules/)"
	@echo ""
	@echo "Extension shell:"
	@echo "  make ext-chrome  Build loadable Chrome MV3 extension at packages/extension/dist/"
	@echo "  make ext-firefox Build loadable Firefox extension at packages/extension/dist/"
	@echo ""
	@echo "Sub-targets (rarely needed directly):"
	@echo "  make rust-build  cargo build --release --workspace"
	@echo "  make rust-test   cargo test --workspace"
	@echo "  make rust-check  cargo check --workspace"
	@echo "  make ts-build    npm run build --workspaces --if-present"
	@echo "  make ts-test     npm test --workspaces --if-present"

# Top-level orchestration
build: rust-build wasm ts-build

test: rust-test ts-test

check: rust-check

clean: rust-clean wasm-clean ts-clean

# Rust targets
rust-build:
	cargo build --release --workspace

rust-test:
	cargo test --workspace

rust-check:
	cargo check --workspace

rust-clean:
	cargo clean

# WASM bundle for browsers (smirk-wasm crate → pkg/, --target web)
wasm:
	cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
	wasm-bindgen --target web \
	  --out-dir crates/smirk-wasm/pkg \
	  target/wasm32-unknown-unknown/release/smirk_wasm.wasm
	@echo ""
	@echo "WASM bundle built:"
	@ls -lh crates/smirk-wasm/pkg/

# Node-loadable WASM bundle for the smoke harness (--target nodejs).
# Produces CommonJS-compatible output that Node can load directly.
# Lives in pkg-node/ alongside pkg/ — both are gitignored.
wasm-node:
	cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
	wasm-bindgen --target nodejs \
	  --out-dir crates/smirk-wasm/pkg-node \
	  target/wasm32-unknown-unknown/release/smirk_wasm.wasm

# Runtime smoke test against the Node WASM build. Catches wasm-bindgen
# typing mismatches, missing exports, and runtime bugs that native unit
# tests miss. See docs/TESTING.md.
wasm-smoke: wasm-node
	node scripts/wasm-smoke.mjs

wasm-clean:
	rm -rf crates/smirk-wasm/pkg crates/smirk-wasm/pkg-node

# TypeScript workspace targets

ts-install:
	npm install

ts-build: ts-install wasm
	npm run build --workspaces --if-present

ts-typecheck:
	npm run typecheck --workspaces --if-present

ts-test:
	npm test --workspaces --if-present

ts-clean:
	rm -rf node_modules
	rm -rf packages/*/dist
	rm -rf packages/*/node_modules

# Extension package — produces a loadable unpacked extension in
# packages/extension/dist/. Depends on the WASM bundle (copied in by
# the vite plugin) and on @smirk/core + @smirk/wasm being built.
ext-chrome: wasm
	npm run build --workspace @smirk/wasm
	npm run build --workspace @smirk/core
	npm run build:chrome --workspace @smirk/extension

ext-firefox: wasm
	npm run build --workspace @smirk/wasm
	npm run build --workspace @smirk/core
	npm run build:firefox --workspace @smirk/extension
