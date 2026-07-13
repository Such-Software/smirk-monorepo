# Smirk Monorepo build orchestration.
#
# Cross-language build commands. See MONOREPO.md for layout details.

.PHONY: help build test check clean wasm wasm-node wasm-smoke rust-build \
        rust-test rust-check ts-build ts-test ts-typecheck ts-install \
        wasm-clean rust-clean ts-clean ext-chrome ext-firefox libs

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

# WASM bundle for browsers (smirk-wasm crate → pkg/, --target no-modules).
# Why no-modules: wasm-bindgen 0.2.95+ with --target web emits `import * from "env"`
# placeholder imports that no bundler resolves out of the box (see ARCHITECTURE.md
# "Build-pipeline gotchas"). no-modules emits a self-contained IIFE — works in any
# WebView (extension, Capacitor, Tauri) without bundler-specific plugins.
# wasm-bindgen ships with the rustup toolchain in ~/.cargo/bin, which is not on
# PATH when a system cargo (e.g. /usr/bin/cargo) shadows the rustup one. Resolve
# it explicitly so `make wasm` works from a bare shell and on the CI runners.
WASM_BINDGEN ?= $(shell command -v wasm-bindgen 2>/dev/null || echo $(HOME)/.cargo/bin/wasm-bindgen)

wasm:
	@# Reproducible wasm: --remap-path-prefix normalizes the build directory and the
	@# cargo home out of the binary. rustc otherwise hashes absolute paths into symbol
	@# metadata, so the SAME source built in a different dir/user yields a different
	@# .wasm (verified: an AMO-reviewer-style build in /tmp differed until remapped).
	@# With this, any checkout on the same rustc produces byte-identical output, so
	@# reviewers can content-match the wasm. Existing $$RUSTFLAGS are preserved.
	RUSTFLAGS="--remap-path-prefix=$(CURDIR)=/smirk --remap-path-prefix=$(HOME)/.cargo=/cargo $${RUSTFLAGS:-}" \
	  cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
	$(WASM_BINDGEN) --target no-modules \
	  --out-dir crates/smirk-wasm/pkg \
	  target/wasm32-unknown-unknown/release/smirk_wasm.wasm
	@# Patches the no-modules output: (1) replaces broken `require("env")`
	@# C-import placeholders with no-op stubs (never invoked in our paths
	@# per secp256k1zkp/wasm-sysroot/README.md), (2) appends `export { wasm_bindgen };`
	@# so @smirk/wasm can import the IIFE-bound symbol as ESM.
	@node crates/smirk-wasm/postprocess.mjs
	@echo ""
	@echo "WASM bundle built:"
	@ls -lh crates/smirk-wasm/pkg/

# Node-loadable WASM bundle for the smoke harness (--target nodejs).
# Produces CommonJS-compatible output that Node can load directly.
# Lives in pkg-node/ alongside pkg/ — both are gitignored.
wasm-node:
	cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
	$(WASM_BINDGEN) --target nodejs \
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
# Build order is DERIVED, never hand-maintained: scripts/build-workspaces.mjs
# topologically sorts every workspace from its declared deps UNION its real
# `import ... from '@scope/pkg'` statements, so the list can't drift out of sync
# with the code again. (It did, twice: a missing @smirk/dapp-browser AND
# @smirk/swap each broke clean-clone builds while "working" locally only because
# stale dist/ was on disk.) `make libs` builds the shared libraries; ext-chrome /
# ext-firefox add the extension. Dependency-free so AMO reviewers need no tooling.
libs: wasm
	node scripts/build-workspaces.mjs libs

ext-chrome: wasm
	node scripts/build-workspaces.mjs chrome

ext-firefox: wasm
	node scripts/build-workspaces.mjs firefox
