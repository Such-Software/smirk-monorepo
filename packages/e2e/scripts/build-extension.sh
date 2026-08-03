#!/usr/bin/env bash
#
# Build the MV3 extension for the E2E suite against a chosen backend.
#
# The extension bundles the workspace libs (@smirk/assets, @smirk/core, @smirk/ui)
# from their built dist/, so those must be compiled BEFORE the extension's vite
# build picks them up — editing a testid in @smirk/ui has no effect until ui is
# rebuilt. This script does that in order, then builds the extension with the
# backend URL + wallet-API dialect baked in as Vite env vars.
#
# Env overrides:
#   VITE_SMIRK_BACKEND_URL  (default http://127.0.0.1:8080/api/v1 — MUST include /api/v1)
#   VITE_SMIRK_API_STYLE    (default namespaced — smirk-backend-core dialect)
#
# The Playwright fixture loads packages/extension/dist by default; point it
# elsewhere with EXTENSION_DIST if you keep multiple builds around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

BACKEND_URL="${VITE_SMIRK_BACKEND_URL:-http://127.0.0.1:8080/api/v1}"
API_STYLE="${VITE_SMIRK_API_STYLE:-namespaced}"

# Derive the build order from the real dependency graph rather than listing it.
# This used to hand-maintain "assets, core, ui" and silently omitted @smirk/wasm,
# @such-software/smirk-dapp-api, @smirk/dapp-browser, @smirk/swap and
# @smirk/keymap — five of the eight libs. It happened to work on a warm tree
# where those dist/ dirs already existed, and fails on a clean clone, which is
# the case that matters for a new contributor or a fresh CI runner.
echo "[e2e] building workspace libs (derived order)…"
node scripts/build-workspaces.mjs libs

echo "[e2e] building extension → packages/extension/dist"
echo "[e2e]   VITE_SMIRK_BACKEND_URL=$BACKEND_URL"
echo "[e2e]   VITE_SMIRK_API_STYLE=$API_STYLE"
VITE_SMIRK_BACKEND_URL="$BACKEND_URL" \
VITE_SMIRK_API_STYLE="$API_STYLE" \
  npm run build:chrome -w @smirk/extension

echo "[e2e] done — dist at packages/extension/dist"
