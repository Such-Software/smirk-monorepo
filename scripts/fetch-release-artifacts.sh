#!/usr/bin/env bash
# Fetch one successful internal candidate run. Credentials remain in memory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/fetch-release-artifacts.mjs" "$@"
