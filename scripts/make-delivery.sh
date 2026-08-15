#!/usr/bin/env bash
# make-delivery.sh: package release marketing images into a Marketing Media
# delivery, then let the library's own validator say whether it is well formed.
#
# The library defines a mandatory shape: four lifecycle folders per project, and
# an immutable deliveries/YYYY-MM-DD-slug/ holding README.md,
# delivery-manifest.json, SHA256SUMS.txt, the publication bytes, and review
# evidence. Assembling that by hand is where deliveries get rejected: a hash
# computed before the last re-export, a path in the manifest that does not match
# the one in SHA256SUMS.txt, a campaign name promoted to a folder at project
# root. Those are all mechanical, so a script should be doing them.
#
# Three deliberate choices:
#   1. the package starts as a copy of _templates/delivery/ when the library
#      ships one, so a template that grows a file does not quietly stop being
#      carried into new deliveries;
#   2. everything recorded is something this script actually read: the commit,
#      the tag, the input directories, capture dates taken from file mtimes,
#      pixel dimensions measured with ImageMagick;
#   3. the verdict comes from _standards/check_delivery.py, not from here. This
#      script's idea of the contract is a guess; their validator is the contract.
#
# What it does NOT do, and will not pretend to do: capture anything, review
# anything, or judge whether the images are worth shipping. It writes
# `candidate`. --accept records a named human assertion that the visual,
# accessibility, and editorial gates passed, because no tool can check those.
#
# It also assumes plain product capture. A delivery holding a face, a portrait,
# or a cloned voice needs the library's consent gates filled in by hand: this
# script writes consent "not-required", which for that content would be a lie.
#
# Usage:
#   scripts/make-delivery.sh <slug> <images-dir>... [options]
#
#   scripts/make-delivery.sh v0-3-0-desktop-screenshots \
#     linux=~/shots/linux macos=~/shots/macos \
#     --describe linux="Linux AppImage on GNOME, 1440x900, receive and send flows" \
#     --describe macos="macOS 15, 1440x900, same six flows" \
#     --dry-run
#
# Positional:
#   <slug>          lowercase; becomes deliveries/YYYY-MM-DD-<slug>
#   <images-dir>    directory of images. NAME=DIR names the set and its folder
#                   in the package; a bare DIR uses the directory's basename.
#
# Options:
#   --project NAME        project folder in the library (default: smirk)
#   --library PATH        library root (default: $SMIRK_MEDIA_LIB, else
#                         ~/Seafile/Marketing Media)
#   --describe NAME=TEXT  what a set is and what it is for. Required by --accept.
#   --title TEXT          human title (default: the slug, verbatim)
#   --version X.Y.Z       release version (default: root package.json)
#   --date YYYY-MM-DD     delivery date (default: today)
#   --captured-on TEXT    when the images were captured (default: input mtimes)
#   --job TEXT            what produced the images (default: the input paths)
#   --host-role TEXT      who captured the images and on what (default: this
#                         packaging host, which is not the same claim)
#   --publication SCOPE   private | internal-review | public
#                         (default: internal-review)
#   --license TEXT        (default: proprietary)
#   --notes TEXT          appended to the manifest notes and the README
#   --reviewer NAME       who reviewed. Required by --accept.
#   --accept              mark the manifest accepted. Refused unless the tree is
#                         clean, dimensions were measured, and every set has a
#                         --describe: an accepted delivery cannot have an
#                         unmet gate in it.
#   --dry-run             stage and validate in a temp dir; never touch the library
set -euo pipefail

usage() {
  # Printed from this file's own header so the two cannot drift apart. Stops at
  # the first line that is not a comment.
  awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

die() { echo "make-delivery: $*" >&2; exit 1; }

[ $# -gt 0 ] || { usage; exit 2; }
case "$1" in -h|--help) usage; exit 2 ;; esac

SLUG="$1"; shift

PROJECT="smirk"
LIB="${SMIRK_MEDIA_LIB:-$HOME/Seafile/Marketing Media}"
TITLE=""
VERSION=""
DELIVERY_DATE="$(date +%Y-%m-%d)"
CAPTURED_ON=""
JOB=""
HOST_ROLE=""
PUBLICATION="internal-review"
LICENSE="proprietary"
EXTRA_NOTES=""
REVIEWER=""
ACCEPT=0
DRY_RUN=0

# Parallel arrays rather than an associative array: this has to run on whatever
# bash the capture host happens to have, and declare -A needs bash 4.
SET_NAMES=(); SET_DIRS=(); SET_DESCS=()
DESC_NAMES=(); DESC_TEXTS=()

add_set() {                 # add_set <NAME=DIR|DIR>
  local arg="$1" name dir
  case "$arg" in
    *=*) name="${arg%%=*}"; dir="${arg#*=}" ;;
    *)   dir="$arg"; name="$(basename "$dir")" ;;
  esac
  # Tilde survives quoting in NAME=~/dir, so expand it here rather than handing
  # a literal "~" to cp and failing three steps later.
  case "$dir" in "~"/*) dir="$HOME/${dir#"~"/}" ;; esac
  [ -d "$dir" ] || die "not a directory: $dir"
  dir="$(cd "$dir" && pwd)"
  case "$name" in
    ""|*/*|.|..) die "bad set name: '$name' (no slashes, must not be empty)" ;;
  esac
  case "$name" in
    *[!a-zA-Z0-9._-]*) die "bad set name: '$name' (use a-z 0-9 . _ - only)" ;;
  esac
  local existing
  for existing in ${SET_NAMES[@]+"${SET_NAMES[@]}"}; do
    [ "$existing" = "$name" ] && die "duplicate set name: '$name'"
  done
  SET_NAMES+=("$name"); SET_DIRS+=("$dir"); SET_DESCS+=("")
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="${2:?--project needs a value}"; shift ;;
    --library)      LIB="${2:?--library needs a value}"; shift ;;
    --title)        TITLE="${2:?--title needs a value}"; shift ;;
    --version)      VERSION="${2:?--version needs a value}"; shift ;;
    --date)         DELIVERY_DATE="${2:?--date needs a value}"; shift ;;
    --captured-on)  CAPTURED_ON="${2:?--captured-on needs a value}"; shift ;;
    --job)          JOB="${2:?--job needs a value}"; shift ;;
    --host-role)    HOST_ROLE="${2:?--host-role needs a value}"; shift ;;
    --publication)  PUBLICATION="${2:?--publication needs a value}"; shift ;;
    --license)      LICENSE="${2:?--license needs a value}"; shift ;;
    --notes)        EXTRA_NOTES="${2:?--notes needs a value}"; shift ;;
    --reviewer)     REVIEWER="${2:?--reviewer needs a value}"; shift ;;
    --describe)
      arg="${2:?--describe needs NAME=TEXT}"; shift
      case "$arg" in *=*) ;; *) die "--describe wants NAME=TEXT, got: $arg" ;; esac
      DESC_NAMES+=("${arg%%=*}"); DESC_TEXTS+=("${arg#*=}") ;;
    --accept)       ACCEPT=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    -h|--help)      usage; exit 2 ;;
    -*)             die "unknown option: $1" ;;
    *)              add_set "$1" ;;
  esac
  shift
done

[ ${#SET_NAMES[@]} -gt 0 ] || die "no image directories given. See --help."

SET_LIST=""
for n in "${SET_NAMES[@]}"; do SET_LIST="$SET_LIST $n"; done

# Attach descriptions now that every set is known, so a typo in --describe is a
# hard error instead of a bullet that silently never appears in the README.
i=0
while [ $i -lt ${#DESC_NAMES[@]} ]; do
  matched=0
  j=0
  while [ $j -lt ${#SET_NAMES[@]} ]; do
    if [ "${SET_NAMES[$j]}" = "${DESC_NAMES[$i]}" ]; then
      SET_DESCS[$j]="${DESC_TEXTS[$i]}"; matched=1
    fi
    j=$((j + 1))
  done
  [ $matched -eq 1 ] || die "--describe names an unknown set: '${DESC_NAMES[$i]}'"
  i=$((i + 1))
done

case "$PUBLICATION" in
  private|internal-review|public) ;;
  *) die "--publication must be private, internal-review, or public" ;;
esac
case "$PROJECT" in
  ""|*/*|.|..) die "bad --project: '$PROJECT' (a single folder name)" ;;
esac
case "$DELIVERY_DATE" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) die "--date must be YYYY-MM-DD, got: $DELIVERY_DATE" ;;
esac

# The library's editorial gate rejects mutable names, and its IDs already carry
# the date, so a dated slug would produce 2026-08-15-2026-08-15-foo.
case "$SLUG" in
  ""|-*|*[!a-z0-9-]*) die "slug must be lowercase a-z 0-9 and dashes, got: '$SLUG'" ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*) die "slug already starts with a date; pass just the name (the delivery ID adds --date)" ;;
  latest|final|final-final|new|current|tmp|temp|*-latest|*-final|*-final-final)
    die "the editorial gate rejects mutable names like '$SLUG'; name the actual version or campaign" ;;
esac

DELIVERY_ID="$DELIVERY_DATE-$SLUG"

# Fail on a missing library or validator BEFORE touching anything. A synced
# library is the worst possible place to discover a half-formed package.
[ -d "$LIB" ] || die "library not found: $LIB
  set SMIRK_MEDIA_LIB or pass --library. Is Seafile mounted and synced?"
CHECKER="$LIB/_standards/check_delivery.py"
[ -f "$CHECKER" ] || die "validator not found: $CHECKER
  this script will not install a package it cannot get verified. Sync the
  library's _standards/ folder, or point --library at a complete checkout."

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else die "python3 not found, and it is needed to run $CHECKER"; fi

if command -v sha256sum >/dev/null 2>&1; then SHA256=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then SHA256=(shasum -a 256)
else die "neither sha256sum nor shasum found; the integrity gate needs one"; fi
sha256_of() { "${SHA256[@]}" "$1" | awk '{print $1}'; }

# ImageMagick 7 puts everything behind `magick`; 6 ships the tools standalone.
IDENTIFY=(); MONTAGE=(); IM_VERSION=""
if command -v magick >/dev/null 2>&1; then
  IDENTIFY=(magick identify); MONTAGE=(magick montage)
elif command -v identify >/dev/null 2>&1; then
  IDENTIFY=(identify); [ -x "$(command -v montage || true)" ] && MONTAGE=(montage)
fi
if [ ${#IDENTIFY[@]} -gt 0 ]; then
  IM_VERSION="$("${IDENTIFY[@]}" -version 2>/dev/null | head -n1 | sed 's/^Version: //' || true)"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_PARENT="$LIB/$PROJECT/deliveries"
DEST="$DEST_PARENT/$DELIVERY_ID"

# Deliveries are immutable by definition: a correction is a NEW delivery ID, not
# an edit. Checked here and again immediately before the move.
[ -e "$DEST" ] && die "delivery already exists: $DEST
  accepted bytes are immutable. A correction gets a new YYYY-MM-DD-slug ID, and
  the old package becomes superseded or archived. Pick another slug or --date."

# Provenance is a required gate and it wants an exact commit, so a checkout this
# script cannot read is a hard stop rather than a manifest full of "unknown".
command -v git >/dev/null 2>&1 || die "git not found; the provenance gate needs an exact commit"
git_at() { git -C "$ROOT" "$@" 2>/dev/null; }
COMMIT="$(git_at rev-parse HEAD || true)"
[ -n "$COMMIT" ] || die "cannot read a commit from $ROOT; the provenance gate needs one"
TAG="$(git_at describe --tags --exact-match || true)"
TAG_EXACT=1
if [ -z "$TAG" ]; then
  TAG_EXACT=0
  TAG="$(git_at describe --tags --always || true)"
fi
DIRTY=0
[ -n "$(git_at status --porcelain || true)" ] && DIRTY=1

REPO_URL="$(git_at remote get-url origin || true)"
REPO=""
if [ -n "$REPO_URL" ]; then
  REPO="$(printf '%s' "$REPO_URL" | sed -e 's#^.*[:/]\([^/:]*\)/\([^/]*\)$#\1/\2#' -e 's#\.git$##')"
fi
[ -n "$REPO" ] || REPO="$(basename "$ROOT")"

if [ -z "$VERSION" ] && [ -f "$ROOT/package.json" ]; then
  VERSION="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version") or "")' "$ROOT/package.json" 2>/dev/null || true)"
fi
[ -n "$VERSION" ] || VERSION="unversioned"

# The slug verbatim: turning dashes into spaces reads "v0-3-0-desktop" as
# "v0 3 0 desktop", and a mangled version number in a title is worse than a
# terse one. The editorial gate wants a human title, so --title exists.
TITLE_DEFAULTED=0
if [ -z "$TITLE" ]; then TITLE="$SLUG"; TITLE_DEFAULTED=1; fi

# "packaging" and not "capture": this host ran the script, and nothing here
# knows where the images were actually taken. --host-role is how that gets said.
[ -n "$HOST_ROLE" ] || HOST_ROLE="packaged on $(uname -s) $(uname -m) ($(hostname 2>/dev/null || echo unknown))"

CREATED_AT="$("$PY" -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat())')"

if [ "$ACCEPT" -eq 1 ]; then
  [ -n "$REVIEWER" ] || die "--accept needs --reviewer NAME: an accepted delivery has to name who accepted it"
  # Refused up front rather than left for the validator, because these are
  # cheap to check and expensive to discover after a long staging run.
  [ "$DIRTY" -eq 0 ] || die "refusing --accept from a dirty checkout: the provenance gate wants an
  exact commit, and $COMMIT does not describe a tree with uncommitted changes.
  Commit or stash, re-capture if the change touched the app, then re-run."
  [ -n "$IM_VERSION" ] || die "refusing --accept without ImageMagick: the technical gate wants measured
  dimensions per artifact and there is no way to record any from this host.
  Package it as a candidate here, or run this on a host with ImageMagick."
  k=0
  while [ $k -lt ${#SET_NAMES[@]} ]; do
    [ -n "${SET_DESCS[$k]}" ] || die "--accept needs --describe ${SET_NAMES[$k]}=\"...\": the editorial gate requires an intended use for every set"
    k=$((k + 1))
  done
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/make-delivery.XXXXXX")"
STAGE="$TMP/$DELIVERY_ID"
ARTIFACTS="$TMP/artifacts.tsv"
INSTALLED=0
: > "$ARTIFACTS"

cleanup() {
  # Keep the staging copy on any failure: it is the evidence of what went wrong,
  # and re-running the capture to get it back is expensive.
  if [ "$INSTALLED" -eq 1 ]; then rm -rf "$TMP"; else
    echo
    echo "staged package left at: $STAGE"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE"

# Start from the library's own template when it has one, so anything the
# template grows later is carried without editing this script. README.md and
# delivery-manifest.json are overwritten below; anything else is reported,
# because a placeholder that ships by accident is a rejected delivery.
TEMPLATE="$LIB/_templates/delivery"
CARRIED=""
if [ -d "$TEMPLATE" ]; then
  cp -R "$TEMPLATE/." "$STAGE/"
  CARRIED="$(cd "$STAGE" && find . -type f | sed 's|^\./||' \
    | grep -v -x -e 'README.md' -e 'delivery-manifest.json' -e 'SHA256SUMS.txt' | LC_ALL=C sort || true)"
  echo "template: copied $TEMPLATE"
  if [ -n "$CARRIED" ]; then
    echo "  WARNING: the template also contributed files this script did not generate."
    echo "           They will be checksummed into the package as-is. Check them:"
    printf '%s\n' "$CARRIED" | sed 's/^/             /'
  fi
else
  echo "template: $TEMPLATE is absent, generating the package from scratch"
  echo "  note: only README.md, delivery-manifest.json and SHA256SUMS.txt are"
  echo "        generated. If the library's template has grown other required"
  echo "        files, this package will be missing them and the validator says so."
fi

media_type_of() {           # media_type_of <path>
  local f="$1" ext
  ext="$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    png)        echo image/png ;;
    jpg|jpeg)   echo image/jpeg ;;
    webp)       echo image/webp ;;
    gif)        echo image/gif ;;
    avif)       echo image/avif ;;
    tif|tiff)   echo image/tiff ;;
    svg)        echo image/svg+xml ;;
    pdf)        echo application/pdf ;;
    mp4)        echo video/mp4 ;;
    webm)       echo video/webm ;;
    mov)        echo video/quicktime ;;
    md)         echo text/markdown ;;
    txt)        echo text/plain ;;
    json)       echo application/json ;;
    *)
      local guess=""
      command -v file >/dev/null 2>&1 && guess="$(file --mime-type -b "$f" 2>/dev/null || true)"
      case "$guess" in
        application/octet-stream)
          die "file(1) cannot identify $f beyond a blob of bytes.
  A marketing delivery has no room for an artifact nobody can name. Remove it
  from the input set." ;;
        [a-z0-9.+-]*/[a-z0-9.+-]*)
          echo "  note: $(basename "$f") has no known extension; file(1) calls it $guess" >&2
          echo "$guess" ;;
        *) die "cannot determine a media type for: $f
  the manifest schema needs a real type/subtype. Remove the file from the input
  set, or convert it to something the delivery is actually supposed to publish." ;;
      esac ;;
  esac
}

measure() {                 # measure <path>  ->  "W H COLORSPACE" or empty
  [ ${#IDENTIFY[@]} -gt 0 ] || return 0
  # head -n1 keeps this to one line for multi-frame files (an animated GIF
  # prints one line per frame); `|| true` absorbs the SIGPIPE that causes.
  "${IDENTIFY[@]}" -format '%w %h %[colorspace]\n' "$1" 2>/dev/null | head -n1 || true
}

add_artifact() {            # add_artifact <relpath> <role> <media_type> [w] [h] [colorspace]
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" "${5:-}" "${6:-}" >> "$ARTIFACTS"
}

echo
echo "delivery: $PROJECT/deliveries/$DELIVERY_ID"
[ "$TITLE_DEFAULTED" -eq 1 ] && echo "  note: title is the slug; --title gives it one a human wrote"
[ "$DIRTY" -eq 1 ] && echo "  WARNING: $ROOT has uncommitted changes, so the recorded commit is approximate"

TOTAL_FILES=0
TOTAL_SKIPPED=0
SET_SUMMARY="$TMP/sets.txt"
: > "$SET_SUMMARY"

s=0
while [ $s -lt ${#SET_NAMES[@]} ]; do
  name="${SET_NAMES[$s]}"; dir="${SET_DIRS[$s]}"
  mkdir -p "$STAGE/$name"
  # A newline in a filename arrives here as two lines and would write a name
  # into SHA256SUMS.txt that matches no file. Counting entries two ways is the
  # portable way to notice: -exec prints once per file, -print once per line.
  lines="$(cd "$dir" && find . -type f -print | wc -l | tr -d ' ')"
  entries="$(cd "$dir" && find . -type f -exec printf 'x\n' \; | wc -l | tr -d ' ')"
  [ "$lines" = "$entries" ] || die "a filename under $dir contains a newline.
  SHA256SUMS.txt is a line-based format and cannot describe it. Rename the file
  before packaging."

  count=0
  skipped=0
  # Dotfiles are dropped wholesale: .DS_Store and AppleDouble ._* sidecars ride
  # along with anything that touched a Mac, and a delivery that publishes them
  # leaks directory metadata and fails review for no good reason.
  while IFS= read -r rel; do
    base="$(basename "$rel")"
    case "$rel" in .*|*/.*) skipped=$((skipped + 1)); continue ;; esac
    case "$base" in Thumbs.db|desktop.ini) skipped=$((skipped + 1)); continue ;; esac
    case "$rel" in
      *"$(printf '\t')"*|*\\*) die "input path contains a tab or a backslash, which SHA256SUMS.txt cannot represent: $dir/$rel" ;;
    esac
    src="$dir/$rel"
    [ -s "$src" ] || die "zero-byte file in the input set: $src
  the manifest schema requires every artifact to have at least one byte, and an
  empty image means the capture failed. Fix the capture, do not ship the hole."
    mkdir -p "$STAGE/$name/$(dirname "$rel")"
    # -p keeps the mtime, which is the only honest record of when the image was
    # captured once it has left the capture host.
    cp -p "$src" "$STAGE/$name/$rel"
    # Typed from the source path so a complaint names a file the operator can
    # actually go and fix, rather than a copy in a temp dir.
    mt="$(media_type_of "$src")"
    dims="$(measure "$STAGE/$name/$rel")"
    add_artifact "$name/$rel" publication "$mt" ${dims:-}
    count=$((count + 1))
  done < <(cd "$dir" && find . -type f -print | sed 's|^\./||' | LC_ALL=C sort)

  [ "$count" -gt 0 ] || die "no usable files in $dir (found only dotfiles or nothing at all)"
  printf '%s\t%s\t%s\t%s\n' "$name" "$dir" "$count" "${SET_DESCS[$s]}" >> "$SET_SUMMARY"
  echo "  $name: $count file(s) from $dir$([ "$skipped" -gt 0 ] && echo " ($skipped skipped)")"
  TOTAL_FILES=$((TOTAL_FILES + count))
  TOTAL_SKIPPED=$((TOTAL_SKIPPED + skipped))
  s=$((s + 1))
done

# Capture dates from the copied bytes, so the date is a property of the images
# rather than of whenever someone got round to packaging them.
CAPTURED_FROM="operator supplied"
if [ -z "$CAPTURED_ON" ]; then
  CAPTURED_FROM="from image mtimes"
  CAPTURED_ON="$("$PY" - "$STAGE" <<'PYEOF'
import datetime, os, sys
stamps = [
    os.path.getmtime(os.path.join(d, f))
    for d, _, files in os.walk(sys.argv[1])
    for f in files
]
if stamps:
    fmt = lambda t: datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d")
    lo, hi = fmt(min(stamps)), fmt(max(stamps))
    print(lo if lo == hi else lo + " to " + hi)
PYEOF
)"
fi
[ -n "$CAPTURED_ON" ] || { CAPTURED_ON="unknown"; CAPTURED_FROM="no mtimes readable"; }

# Review evidence. A contact sheet is what a human actually looks at; REVIEW.md
# is the fallback that always exists, and it is also the index for the sheets.
mkdir -p "$STAGE/review"
SHEETS=0
if [ ${#MONTAGE[@]} -gt 0 ]; then
  s=0
  while [ $s -lt ${#SET_NAMES[@]} ]; do
    name="${SET_NAMES[$s]}"
    sheet="$STAGE/review/$name-contact-sheet.png"
    files=()
    while IFS= read -r f; do files+=("$f"); done < <(
      cd "$STAGE/$name" && find . -type f -print | sed 's|^\./||' | LC_ALL=C sort
    )
    ok=0
    if [ ${#files[@]} -gt 0 ]; then
      ( cd "$STAGE/$name" && "${MONTAGE[@]}" -background '#1b1b1b' -fill '#e8e8e8' \
          -label '%f' -thumbnail '240x240>' -geometry '+8+8' -tile 5x \
          "${files[@]}" "$sheet" ) >/dev/null 2>&1 && ok=1
      if [ $ok -eq 0 ]; then
        # Labels need a usable font, which a headless capture host often lacks.
        # An unlabelled sheet still shows the frames; REVIEW.md carries the order.
        ( cd "$STAGE/$name" && "${MONTAGE[@]}" -background '#1b1b1b' \
            -thumbnail '240x240>' -geometry '+8+8' -tile 5x \
            "${files[@]}" "$sheet" ) >/dev/null 2>&1 && ok=2
      fi
    fi
    if [ $ok -eq 0 ]; then
      rm -f "$sheet"
      echo "  WARNING: could not build a contact sheet for '$name'; REVIEW.md is the only visual index"
    else
      dims="$(measure "$sheet")"
      add_artifact "review/$name-contact-sheet.png" contact-sheet image/png ${dims:-}
      SHEETS=$((SHEETS + 1))
      [ $ok -eq 2 ] && echo "  note: contact sheet for '$name' is unlabelled (no usable font on this host)"
    fi
    s=$((s + 1))
  done
else
  echo "  WARNING: ImageMagick not found, so there are no contact sheets."
  echo "           REVIEW.md is the review evidence and it has no pixels in it."
fi

{
  echo "# Review index: $TITLE"
  echo
  echo "Delivery \`$DELIVERY_ID\`, captured $CAPTURED_ON."
  echo
  if [ "$SHEETS" -gt 0 ]; then
    echo "Contact sheets in this folder show every frame at thumbnail size. Tiles are"
    echo "in the order listed below. Review at full size in the set folders; a"
    echo "thumbnail cannot show clipped type or a broken glyph."
  else
    echo "No contact sheets: ImageMagick was not available on the packaging host."
    echo "Review the full-size images in the set folders."
  fi
  echo
  while IFS="$(printf '\t')" read -r name dir count desc; do
    echo "## $name"
    echo
    [ -n "$desc" ] && { echo "$desc"; echo; }
    echo "$count file(s), staged from \`$dir\`."
    echo
    if [ -n "$IM_VERSION" ]; then
      echo "| file | pixels | bytes |"
      echo "|---|---|---|"
    else
      echo "| file | bytes |"
      echo "|---|---|"
    fi
    while IFS="$(printf '\t')" read -r p role mt w h cs; do
      case "$p" in "$name"/*) ;; *) continue ;; esac
      bytes="$(wc -c < "$STAGE/$p" | tr -d ' ')"
      if [ -n "$IM_VERSION" ]; then
        echo "| \`${p#"$name"/}\` | ${w:-?}x${h:-?} | $bytes |"
      else
        echo "| \`${p#"$name"/}\` | $bytes |"
      fi
    done < "$ARTIFACTS"
    echo
  done < "$SET_SUMMARY"
  echo "Hashes and byte sizes are in \`../delivery-manifest.json\` and"
  echo "\`../SHA256SUMS.txt\`; they are deliberately not repeated here, so there is"
  echo "exactly one place to check them."
} > "$STAGE/review/REVIEW.md"
add_artifact "review/REVIEW.md" report text/markdown

# QA checks record only what this run actually verified. Anything a human has to
# look at is absent unless --accept adds it, signed with a name.
QA_CHECKS="$TMP/qa.tsv"
: > "$QA_CHECKS"
# A dirty tree fails provenance rather than passing it quietly. On a candidate
# that is just an honest record; on --accept the library's validator turns it
# into a rejection, which is the correct outcome.
PROVENANCE=pass
PROVENANCE_EVIDENCE="source commit $COMMIT in $REPO; images staged from:$SET_LIST"
if [ "$DIRTY" -eq 1 ]; then
  PROVENANCE=fail
  PROVENANCE_EVIDENCE="$PROVENANCE_EVIDENCE. The checkout had uncommitted changes, so this commit does not describe the tree that produced these images."
fi
printf '%s\t%s\t%s\n' provenance "$PROVENANCE" "$PROVENANCE_EVIDENCE" >> "$QA_CHECKS"
printf '%s\t%s\t%s\n' integrity pass \
  "SHA-256 and byte size recorded per artifact from the staged bytes, cross-checked against SHA256SUMS.txt by _standards/check_delivery.py before install" >> "$QA_CHECKS"
if [ -n "$IM_VERSION" ]; then
  printf '%s\t%s\t%s\n' technical pass \
    "pixel dimensions and colour space measured per artifact with $IM_VERSION" >> "$QA_CHECKS"
fi
if [ "$ACCEPT" -eq 1 ]; then
  printf '%s\t%s\t%s\n' human-review pass \
    "visual, accessibility, and editorial gates reviewed outside this tool and asserted by $REVIEWER on $DELIVERY_DATE" >> "$QA_CHECKS"
fi

# Checked here because it is only knowable after montage has had its turn: a
# delivery whose review evidence is a text listing has nothing for the visual
# gate to have been reviewed against.
if [ "$ACCEPT" -eq 1 ] && [ "$SHEETS" -eq 0 ]; then
  die "refusing --accept with no contact sheets: the library wants representative
  review evidence and this package would ship a file listing instead. The
  staged copy is kept below so the ImageMagick failure can be reproduced."
fi

STATUS=candidate; QA_STATUS=pending
[ "$ACCEPT" -eq 1 ] && { STATUS=accepted; QA_STATUS=pass; }

[ -n "$JOB" ] || {
  JOB="scripts/make-delivery.sh packaging of pre-captured images from:"
  sep=" "
  while IFS="$(printf '\t')" read -r name dir count desc; do
    JOB="$JOB$sep$dir ($name, $count file(s))"
    sep="; "
  done < "$SET_SUMMARY"
}

RENDERER="scripts/make-delivery.sh (packaging only; the images were captured upstream by another tool)"
[ -n "$IM_VERSION" ] && RENDERER="$RENDERER, contact sheets by $IM_VERSION"

NOTES="Captured $CAPTURED_ON; packaged $CREATED_AT from $REPO at $COMMIT"
if [ "$TAG_EXACT" -eq 1 ]; then NOTES="$NOTES (tag $TAG)"
elif [ -n "$TAG" ]; then NOTES="$NOTES (nearest tag $TAG, HEAD is not tagged)"
else NOTES="$NOTES (no tag reachable)"; fi
NOTES="$NOTES. Packaged by scripts/make-delivery.sh, which measured hashes, byte sizes"
[ -n "$IM_VERSION" ] && NOTES="$NOTES, and pixel dimensions"
NOTES="$NOTES, but reviewed nothing."
[ -z "$IM_VERSION" ] && NOTES="$NOTES ImageMagick was absent on the packaging host, so no dimensions were measured and there are no contact sheets."
[ "$DIRTY" -eq 1 ] && NOTES="$NOTES WARNING: the source checkout had uncommitted changes when this was packaged, so commit $COMMIT does not fully describe the tree that produced these images."
[ "$ACCEPT" -eq 0 ] && NOTES="$NOTES Candidate: visual, accessibility, and editorial review are outstanding."
[ -n "$EXTRA_NOTES" ] && NOTES="$NOTES $EXTRA_NOTES"

# The manifest is built in python because bash cannot be trusted to escape a
# filename into JSON, and one bad quote here is a rejected delivery.
DELIVERY_ID="$DELIVERY_ID" PROJECT="$PROJECT" TITLE="$TITLE" CREATED_AT="$CREATED_AT" \
STATUS="$STATUS" REPO="$REPO" COMMIT="$COMMIT" JOB="$JOB" TOOL="$PROJECT" \
VERSION="$VERSION" RENDERER="$RENDERER" HOST_ROLE="$HOST_ROLE" \
PUBLICATION="$PUBLICATION" LICENSE="$LICENSE" NOTES="$NOTES" \
QA_STATUS="$QA_STATUS" REVIEWER="$REVIEWER" REVIEWED_AT="$([ "$ACCEPT" -eq 1 ] && echo "$CREATED_AT" || true)" \
STAGE="$STAGE" ARTIFACTS="$ARTIFACTS" QA_CHECKS="$QA_CHECKS" \
"$PY" <<'PYEOF'
import hashlib
import json
import os
from pathlib import Path

stage = Path(os.environ["STAGE"])


def rows(path, width):
    for line in Path(path).read_text().splitlines():
        if line.strip():
            yield (line.split("\t") + [""] * width)[:width]


artifacts = []
for rel, role, media_type, w, h, colorspace in rows(os.environ["ARTIFACTS"], 6):
    data = (stage / rel).read_bytes()
    technical = {}
    if w and h:
        technical["width"] = int(w)
        technical["height"] = int(h)
    if colorspace:
        technical["color_space"] = colorspace
    artifacts.append(
        {
            "path": rel,
            "role": role,
            "media_type": media_type,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "technical": technical,
        }
    )

checks = [
    {"name": name, "status": status, "evidence": evidence}
    for name, status, evidence in rows(os.environ["QA_CHECKS"], 3)
]

manifest = {
    "schema_version": 1,
    "delivery_id": os.environ["DELIVERY_ID"],
    "project": os.environ["PROJECT"],
    "title": os.environ["TITLE"],
    "created_at": os.environ["CREATED_AT"],
    "status": os.environ["STATUS"],
    "source": {
        "repository": os.environ["REPO"],
        "commit": os.environ["COMMIT"],
        "job": os.environ["JOB"] or None,
        "performance": None,
    },
    "producer": {
        "tool": os.environ["TOOL"],
        "version": os.environ["VERSION"],
        "renderer": os.environ["RENDERER"],
        "host_role": os.environ["HOST_ROLE"] or None,
    },
    "rights": {
        "publication": os.environ["PUBLICATION"],
        "license": os.environ["LICENSE"],
        "notes": "",
    },
    "consent": {
        "required": False,
        "status": "not-required",
        "scope": "",
        "subject": None,
        "date": None,
    },
    "privacy": {
        "contains_biometric_identity": False,
        "contains_cloned_voice": False,
        "standalone_clone_audio_included": False,
        "raw_identity_sources_included": False,
        "private_voice_references_included": False,
    },
    "artifacts": artifacts,
    "qa": {
        "status": os.environ["QA_STATUS"],
        "checks": checks,
        "reviewer": os.environ["REVIEWER"] or None,
        "reviewed_at": os.environ["REVIEWED_AT"] or None,
    },
    "notes": os.environ["NOTES"],
}

(stage / "delivery-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n"
)
PYEOF

{
  echo "# $TITLE"
  echo
  echo "Status: $STATUS"
  echo
  echo "Use this package for:"
  echo
  while IFS="$(printf '\t')" read -r name dir count desc; do
    if [ -n "$desc" ]; then
      echo "- \`$name/\`: $desc ($count file(s))."
    else
      echo "- \`$name/\`: $count file(s). TODO: what this set is for. The packaging"
      echo "  tool was given no description, and the editorial gate needs one before"
      echo "  this delivery can be accepted."
    fi
  done < "$SET_SUMMARY"
  echo
  echo "$TOTAL_FILES image artifact(s) across ${#SET_NAMES[@]} set(s), plus review evidence in \`review/\`."
  [ "$TOTAL_SKIPPED" -gt 0 ] && echo "$TOTAL_SKIPPED dotfile(s) in the inputs were skipped and are not part of this package."
  echo
  echo "Source:"
  echo
  echo "- repository: \`$REPO\`"
  echo "- commit: \`$COMMIT\`"
  if [ "$TAG_EXACT" -eq 1 ]; then
    echo "- tag: \`$TAG\`"
  elif [ -n "$TAG" ]; then
    echo "- tag: none on HEAD; nearest is \`$TAG\`"
  else
    echo "- tag: none reachable from HEAD"
  fi
  echo "- release version: \`$VERSION\`"
  echo "- captured: $CAPTURED_ON ($CAPTURED_FROM)"
  echo "- host: $HOST_ROLE"
  echo "- staged from:"
  while IFS="$(printf '\t')" read -r name dir count desc; do
    echo "  - \`$name/\` from \`$dir\`"
  done < "$SET_SUMMARY"
  echo "- job/performance: see \`delivery-manifest.json\`"
  if [ "$DIRTY" -eq 1 ]; then
    echo
    echo "**The source checkout had uncommitted changes when this was packaged.**"
    echo "Commit \`$COMMIT\` therefore describes the tree only approximately. Treat the"
    echo "provenance gate as unmet until these bytes are re-cut from a clean tree."
  fi
  echo
  echo "Rights and consent:"
  echo
  echo "- publication scope: $PUBLICATION"
  echo "- license: $LICENSE"
  echo "- consent: not required (product capture; no identity or voice content)"
  echo "- excluded private/raw inputs: none. This package holds application"
  echo "  screenshots only."
  echo
  echo "Quality evidence:"
  echo
  echo "- integrity: SHA-256 and byte size per artifact in \`delivery-manifest.json\`,"
  echo "  matching \`SHA256SUMS.txt\`. Verified with \`_standards/check_delivery.py\`"
  echo "  before this package was written into the library."
  if [ -n "$IM_VERSION" ]; then
    echo "- technical: pixel dimensions and colour space measured per artifact with"
    echo "  $IM_VERSION. Nothing beyond dimensions was checked."
  else
    echo "- technical: **not measured**. ImageMagick was not available on the"
    echo "  packaging host, so no artifact carries dimensions."
  fi
  if [ "$SHEETS" -gt 0 ]; then
    echo "- visual evidence: \`review/\` holds a contact sheet per set, and"
    echo "  \`review/REVIEW.md\` indexes every frame."
  else
    echo "- visual evidence: \`review/REVIEW.md\` only. **No contact sheets were"
    echo "  produced**, so what this package offers a reviewer is a file listing,"
    echo "  not pixels."
  fi
  if [ "$ACCEPT" -eq 1 ]; then
    echo "- visual, accessibility, and editorial review: asserted by **$REVIEWER**"
    echo "  on $DELIVERY_DATE. The packaging tool checked none of these; it recorded"
    echo "  the assertion."
  else
    echo "- visual review: pending. No human has signed off on these frames."
    echo "- accessibility review: pending (contrast, safe zones, readable type)."
    echo "- editorial review: pending."
  fi
  if [ -n "$EXTRA_NOTES" ]; then
    echo
    echo "Notes:"
    echo
    echo "- $EXTRA_NOTES"
  fi
  echo
  echo "This package was assembled by \`scripts/make-delivery.sh\` in \`$REPO\`. That"
  echo "tool copies, hashes, and measures. It does not capture or review anything."
  if [ "$ACCEPT" -eq 0 ]; then
    echo
    echo "Do not mark the manifest \`accepted\` until every required gate passes, hashes"
    echo "and byte sizes describe the final bytes, and \`SHA256SUMS.txt\` has been"
    echo "regenerated."
  fi
} > "$STAGE/README.md"

# Sums come last and are recomputed from the final bytes, so this file describes
# what is actually in the package rather than what it looked like mid-assembly.
# SHA256SUMS.txt cannot contain itself; everything else does, including the
# README and the manifest.
SUMS_TMP="$TMP/SHA256SUMS.txt"
: > "$SUMS_TMP"
while IFS= read -r rel; do
  printf '%s  %s\n' "$(sha256_of "$STAGE/$rel")" "$rel" >> "$SUMS_TMP"
done < <(cd "$STAGE" && find . -type f ! -name SHA256SUMS.txt -print | sed 's|^\./||' | LC_ALL=C sort)
mv "$SUMS_TMP" "$STAGE/SHA256SUMS.txt"

echo
echo "staged $TOTAL_FILES image(s), $SHEETS contact sheet(s), $(wc -l < "$STAGE/SHA256SUMS.txt" | tr -d ' ') checksummed file(s)"

run_validator() {           # run_validator <package-dir>
  echo
  echo "validator: $CHECKER"
  "$PY" "$CHECKER" "$1"
}

if ! run_validator "$STAGE"; then
  echo
  echo "REJECTED by the library's own validator. Nothing was written to $LIB." >&2
  echo "The staged package is left in place above so the errors can be read against" >&2
  echo "the actual bytes. Fix the inputs and re-run; do not hand-patch the manifest." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "--dry-run: the library was not touched. The package above would have gone to:"
  echo "  $DEST"
  exit 0
fi

# The four lifecycle folders, and only those. Campaign names live in the
# delivery ID, never in a folder at project root.
for d in source work deliveries archive; do
  mkdir -p "$LIB/$PROJECT/$d"
done

# Re-checked immediately before the move: the first check happened before all
# the staging work, and this library syncs.
[ -e "$DEST" ] && die "delivery appeared at $DEST while this ran. Refusing to overwrite it."
mv "$STAGE" "$DEST" || die "could not move the package into the library.
  It is still staged at $STAGE. The library may be mid-sync or out of space;
  nothing was overwritten."
INSTALLED=1

echo
echo "installed: $DEST"

# Validated a second time at the final path, because the copy into a synced
# library is the last thing that can corrupt a byte, and their tool is the only
# opinion that counts.
if ! run_validator "$DEST"; then
  echo
  echo "The package validated in staging but NOT after being written to $DEST." >&2
  echo "Bytes changed on the way in. Do not link this delivery anywhere." >&2
  exit 1
fi

echo
echo "$DELIVERY_ID is $STATUS."
if [ "$ACCEPT" -eq 1 ]; then
  echo "It is marked accepted on $REVIEWER's assertion. This tool did not review"
  echo "the images; it checked hashes, sizes, and dimensions."
else
  echo "It is a candidate. Review the frames, then re-cut with --accept --reviewer NAME"
  echo "under a NEW delivery ID: accepted bytes are immutable and this ID is now taken."
fi
