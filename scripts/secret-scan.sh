#!/usr/bin/env bash
# Scan tracked and untracked source without printing matched values.
set -euo pipefail
exec node "$(dirname "$0")/secret-scan.mjs"
