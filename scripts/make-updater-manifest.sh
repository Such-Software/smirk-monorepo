#!/usr/bin/env bash
# make-updater-manifest.sh: build the `latest.json` the desktop auto-updater reads.
#
# tauri.conf.json sets `updater.active` and pins a minisign public key, and points
# every shipped desktop build at:
#
#   https://github.com/Such-Software/smirk-monorepo/releases/latest/download/latest.json
#
# Nothing produced that file. An updater that is active but has no manifest is not
# a dormant feature: every client checks on launch, gets a 404, and the release
# looks like it shipped an updater when it shipped a broken one. This script
# closes that gap, and refuses to emit a manifest it cannot stand behind.
#
# The signatures are minisign, made by the Tauri bundler from
# TAURI_SIGNING_PRIVATE_KEY, and are what the client verifies before installing.
# They are a separate mechanism from the detached PGP signatures sign-release.sh
# makes: PGP proves who published a download, minisign is what lets the running
# app trust an update it fetched on its own. A release needs both.
#
# Usage:
#   scripts/make-updater-manifest.sh 0.3.0 --bundle-dir ~/smirk-desktop-v0.3.0
#   scripts/make-updater-manifest.sh 0.3.0 --bundle-dir DIR --notes "…"
#
# Run it AFTER staging every platform's artifacts, and BEFORE sign-release.sh, so
# the manifest is covered by the SHA256SUMS the release signs.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> --bundle-dir <dir> [--notes <text>] [--allow-partial]" >&2
  exit 2
fi
shift

BUNDLE_DIR=""
NOTES=""
ALLOW_PARTIAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --notes)      NOTES="${2:-}";      shift 2 ;;
    --allow-partial) ALLOW_PARTIAL=1;  shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BUNDLE_DIR" || ! -d "$BUNDLE_DIR" ]]; then
  echo "error: --bundle-dir must name an existing directory" >&2
  exit 2
fi

if [[ -z "$NOTES" ]]; then
  NOTES="Smirk Wallet $VERSION. See the release notes for what changed."
fi

VERSION="$VERSION" BUNDLE_DIR="$BUNDLE_DIR" NOTES="$NOTES" \
ALLOW_PARTIAL="$ALLOW_PARTIAL" python3 - <<'PY'
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

version = os.environ["VERSION"]
bundle = pathlib.Path(os.environ["BUNDLE_DIR"])
notes = os.environ["NOTES"]
allow_partial = os.environ["ALLOW_PARTIAL"] == "1"

BASE = f"https://github.com/Such-Software/smirk-monorepo/releases/download/v{version}"

# Tauri v2 emits one updater artifact per platform, each beside a `.sig` holding
# its minisign signature. The target keys are the ones the client computes at
# runtime; a key the client never asks for is dead weight, and a key it asks for
# and cannot find means no update on that platform.
#
# macOS ships a single universal .app.tar.gz, so both arch keys point at it.
MATCHERS = [
    ("darwin-aarch64", lambda n: n.endswith(".app.tar.gz")),
    ("darwin-x86_64",  lambda n: n.endswith(".app.tar.gz")),
    ("linux-x86_64",   lambda n: n.endswith(".AppImage")),
    ("windows-x86_64", lambda n: n.endswith("-setup.exe")),
]

# Tauri names every bundle after the product, so each one carries a space:
# "Smirk Wallet_0.3.0_amd64.AppImage". GitHub rewrites spaces to periods when it
# stores a release asset, so a URL built from the local filename points at a name
# that does not exist there, and the updater 404s on a manifest that otherwise
# looks correct.
#
# Rename on disk rather than only fixing the URL, so the staged file, the
# SHA256SUMS sign-release.sh produces, the uploaded asset and this manifest all
# agree on one name. Done as its own pass before matching, because macOS is
# matched twice (both arch keys point at the same universal bundle) and a rename
# inside the match loop invalidates the second lookup.
for path in sorted(p for p in bundle.rglob("*") if p.is_file()):
    if " " in path.name:
        target = path.with_name(path.name.replace(" ", "."))
        if target.exists():
            print(f"error: {target.name} already exists; refusing to clobber", file=sys.stderr)
            sys.exit(1)
        path.rename(target)
        print(f"  renamed {path.name!r} -> {target.name!r} (GitHub asset naming)")

files = sorted(p for p in bundle.rglob("*") if p.is_file())

# Never let an unsigned artifact into the manifest. Windows ships both a signed
# installer and an unsigned one, the latter so the build stays independently
# reproducible. They differ only by suffix today, so the selectors below happen
# not to collide, but "happens not to" is not a property worth relying on: a
# manifest pointing at the unsigned installer would hand every existing user an
# unsigned binary on update and re-raise the SmartScreen warning each time.
files = [p for p in files if "unsigned" not in p.name.lower()]

platforms = {}
missing = []
for key, match in MATCHERS:
    hits = [p for p in files if match(p.name)]
    if not hits:
        missing.append(f"{key}: no updater artifact matched")
        continue
    if len(hits) > 1:
        names = ", ".join(sorted({p.name for p in hits}))
        missing.append(f"{key}: ambiguous, {len(hits)} candidates ({names})")
        continue
    art = hits[0]
    sig = art.with_name(art.name + ".sig")
    if not sig.exists():
        missing.append(
            f"{key}: {art.name} has no .sig "
            "(bundle.createUpdaterArtifacts off, or TAURI_SIGNING_PRIVATE_KEY unset in CI)"
        )
        continue
    signature = sig.read_text(encoding="utf-8").strip()
    if not signature:
        missing.append(f"{key}: {sig.name} is empty")
        continue
    # Percent-encode anything left that is not URL-safe. After the rename above
    # there should be nothing, but a manifest is not the place to find out.
    platforms[key] = {
        "signature": signature,
        "url": f"{BASE}/{urllib.parse.quote(art.name)}",
    }

if missing:
    print("Updater manifest is incomplete:", file=sys.stderr)
    for m in missing:
        print(f"  - {m}", file=sys.stderr)
    if not allow_partial:
        print(
            "\nRefusing to write a partial manifest. A platform absent from latest.json\n"
            "silently never updates, which is worse than a release with no updater at\n"
            "all, because nothing reports it. Stage the missing artifacts, or pass\n"
            "--allow-partial if you are deliberately shipping a subset.",
            file=sys.stderr,
        )
        sys.exit(1)

if not platforms:
    print("error: no platforms resolved; nothing to write", file=sys.stderr)
    sys.exit(1)

# Reproducible: the commit's own timestamp, not wall-clock, so rebuilding the same
# tag yields the same manifest byte for byte.
pub_date = subprocess.run(
    ["git", "log", "-1", "--format=%cI", f"v{version}"],
    capture_output=True, text=True,
).stdout.strip()
if not pub_date:
    pub_date = subprocess.run(
        ["git", "log", "-1", "--format=%cI"], capture_output=True, text=True
    ).stdout.strip()

manifest = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": platforms,
}

out = bundle / "latest.json"
out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

print(f"  wrote {out}")
for key in sorted(platforms):
    print(f"    {key:<16} {platforms[key]['url'].rsplit('/', 1)[1]}")
if missing:
    print(f"  WARNING: {len(missing)} platform(s) omitted; those installs will not auto-update")
PY
