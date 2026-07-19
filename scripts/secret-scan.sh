#!/usr/bin/env bash
# Leak firewall: fail if any tracked file contains private-key material or a
# known-bad project literal (infra IPs, funded test-wallet seed/address). Runs in
# CI and as a pre-commit hook.
#
# Two layers:
#   1. GENERIC secret shapes (below) — patterns that are secret by structure and
#      contain NO project literal, so they are safe to keep in this PUBLIC file.
#   2. PROJECT-SPECIFIC literals — loaded from a GIT-IGNORED file so the actual
#      infra IPs / seed words never live in this public script (the mistake this
#      very file used to make). Absent file => layer 2 is skipped with a warning;
#      a fresh clone / contributor still gets layer 1. CI injects the file from a
#      repository secret (see .github/workflows/docs.yml).
#
# The scan does NOT exclude this script: once the literals moved out, re-adding
# one here (or anywhere tracked) trips the check instead of hiding behind a
# self-exclusion. Deliberately high-confidence / low-false-positive — gitleaks
# layers on in CI for broader coverage.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0

# Match an ERE across all tracked files (-I skips binary). No self-exclusion.
check() {
  local label="$1" regex="$2"
  local out; out="$(git grep -nIE "$regex" 2>/dev/null || true)"
  if [ -n "$out" ]; then printf '\n[LEAK: %s]\n%s\n' "$label" "$(echo "$out" | head -8)"; fail=1; fi
}

# ── Layer 1: generic secret shapes (no project literals; safe in a public file) ──
check "PEM private key block"  '-----BEGIN [A-Z ]*PRIVATE KEY'
check "AWS access key id"      'AKIA[0-9A-Z]{16}'
check "Slack token"            'xox[baprs]-[0-9A-Za-z-]{10,}'
check "generic API bearer"     'https?://[^ ]*:[^ @/]{16,}@'

# ── Layer 2: project-specific known-bad literals (from a git-ignored file) ──
PATTERNS_FILE="${SECRET_SCAN_PATTERNS_FILE:-scripts/secret-scan.local.txt}"
if [ -f "$PATTERNS_FILE" ]; then
  while IFS=$'\t' read -r label regex; do
    [ -z "${label:-}" ] && continue
    case "$label" in \#*) continue;; esac
    [ -z "${regex:-}" ] && continue
    check "$label" "$regex"
  done < "$PATTERNS_FILE"
else
  printf 'secret-scan: WARNING — no project-literal file at %s; ran generic checks only.\n' "$PATTERNS_FILE" >&2
  printf '  (maintainers/CI supply it; see the header. Fresh clones can ignore this.)\n' >&2
fi

if [ "$fail" -ne 0 ]; then
  echo; echo "secret-scan FAILED: remove the above before committing/pushing."; exit 1
fi
echo "secret-scan clean."
