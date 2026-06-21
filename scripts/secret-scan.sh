#!/usr/bin/env bash
# Leak firewall: fail if any tracked file contains infra identifiers, private
# keys, or known test-wallet seed material. Runs in CI and as a pre-commit hook.
#
# Deliberately high-confidence / low-false-positive: it flags things that must
# never be public, not every string that looks secret-ish. A generic scanner
# (gitleaks) can layer on top in CI for broader coverage.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0
check() {
  local label="$1"; shift
  local out; out="$(git grep -nIE "$@" -- ':!scripts/secret-scan.sh' 2>/dev/null || true)"
  if [ -n "$out" ]; then printf '\n[LEAK: %s]\n%s\n' "$label" "$(echo "$out" | head -8)"; fail=1; fi
}
check "nebula/infra IP"     '***REMOVED-INFRA***'
check "private key block"   '-----BEGIN [A-Z ]*PRIVATE KEY'
check "test-wallet address" '***REMOVED-ADDR***'
check "test seed marker"    '***REMOVED-SEED***'
if [ "$fail" -ne 0 ]; then
  echo; echo "secret-scan FAILED: remove the above before committing/pushing."; exit 1
fi
echo "secret-scan clean."
