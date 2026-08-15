#!/usr/bin/env bash
# capture-desktop.sh: marketing screenshots of the Tauri DESKTOP app, headless.
#
# v0.3.0 is the first release with a desktop app and there are zero screenshots
# of it. The extension frames come from Playwright
# (packages/e2e/tests/marketing-shots.spec.ts), which addresses elements by test
# id; a PACKAGED Tauri release offers no such handle. Release builds ship with
# devtools off, so there is no inspector, no WebDriver, and no way to evaluate JS
# in the webview. Everything below is therefore synthetic keyboard input into a
# real window under Xvfb, and every frame is checked afterwards with ImageMagick.
#
# Frames it writes (names mirror the extension set so both sit in one folder):
#   00-first-run          Welcome screen, before a wallet exists
#   07-self-host-backend  onboarding backend picker  (only with --backend)
#   01-home-balances      multi-asset Home with the fiat total
#   04-swap               Swap tab
#   05-inbox              Inbox tab
#   08-settings           Settings tab
#   10-browse             Browse tab, desktop-only (the extension has no such tab)
#
# Frames it does NOT write, and why. 02-receive-xmr, 03-send-btc,
# 06-nostr-identity and 09-connected-sites all sit behind in-content controls:
# the Home action row, a Settings row. Reaching those blind means Tab-counting
# through a screen whose focusable set changes with balances, banners, claimable
# tips and backend capabilities, or clicking a coordinate that the next layout
# tweak invalidates. The capture wallet holds real funds (see
# packages/smoke-tests/README.md), so pressing Enter on an element this script
# cannot identify is not acceptable: on Home a stray Enter can land on a tip
# Claim button. The top-level TABS are safely addressable (they are the first
# focusables in the document and they live in the sidebar, where the focus ring
# is visible to a pixel check), so tab-level surfaces are what this captures.
# The rest needs a DOM-aware driver: a desktop build with Tauri's `devtools`
# feature, driven over the WebKit inspector protocol.
#
# Usage:
#   scripts/capture-desktop.sh --dry-run              # check everything, launch nothing
#   scripts/capture-desktop.sh
#   scripts/capture-desktop.sh --backend https://backend.smirk.cash/api/v1
#   scripts/capture-desktop.sh --no-wallet            # only 00-first-run (harness smoke test)
#   MARKETING_OUT=/tmp/frames scripts/capture-desktop.sh --force
#
# Runs on the Linux box only (Xvfb + xdotool + an AppImage). It never touches the
# operator's real wallet data: the app is launched with XDG_CONFIG_HOME and
# friends pointed at a throwaway profile that is deleted on exit.
set -euo pipefail
# Deterministic number formatting and sort order: the pixel-difference maths below
# parses ImageMagick's output with printf.
export LC_ALL=C

# ============================================================================
# Knobs
# ============================================================================

VERSION="0.3.0"
APPIMAGE_DEFAULT="$HOME/smirk-desktop-v$VERSION/linux/Smirk Wallet_${VERSION}_amd64.AppImage"
MNEMONIC_ENV_DEFAULT="$HOME/src/smirk-monorepo/packages/smoke-tests/secrets/smoke-mnemonics.env"
OUT_DIR="${MARKETING_OUT:-$HOME/Build/smirk-marketing/raw/desktop}"

# Wallet password for the throwaway profile. Same value the e2e fixtures use, so
# that a profile kept with --keep-profile can still be unlocked by hand.
PASSWORD="e2e-test-password-123"

# Window title from packages/desktop/src-tauri/tauri.conf.json (app.windows[0].title).
WINDOW_TITLE="Smirk Wallet"
# The X server must be larger than the window; import(1) grabs the screen area
# the window covers, so anything hanging off the edge would capture as garbage.
XVFB_SCREEN="${SMIRK_XVFB_SCREEN:-1600x1000x24}"

# --- the layout-derived constants ---
#
# There are no click coordinates anywhere in this script: every step is keyboard
# input, because a coordinate is wrong the moment a row is added to a screen.
# These three numbers are the only things here that depend on the UI's shape, and
# all three are read out of the source rather than measured off a screenshot.
#
# SIDEBAR_W: AppShell renders a 200px-wide `aside` whenever window.outerWidth
# > 500 (packages/ui/src/components/shell/AppShell.tsx + state/hooks.tsx
# useIsPopout). The desktop window is 1024 wide, so the nav is ALWAYS that
# sidebar, and it precedes <main> in the DOM. That is what makes the tabs
# reachable by Tab at all. Cropping to this column is how we watch the focus
# ring without caring what the tab body is doing.
SIDEBAR_W=200
# NAV_HOME_TABS: presses of Tab, from an unfocused document, to land on the FIRST
# nav tab (Home). The sidebar header holds two buttons ahead of it: the identity
# switcher and the refresh button (popup/index.tsx headerActions). Validated at
# runtime before anything is pressed, so a wrong value fails loudly instead of
# activating the wrong control.
NAV_HOME_TABS=3
# MAX_NAV_TABS: upper bound for the focus walk that finds the last nav tab.
# BottomNav ships 4 base tabs plus an optional Feed tab (backend advertises one)
# plus Browse on desktop, so 6 is the real ceiling; the walk stops on its own.
MAX_NAV_TABS=8

# --- timing. There is no readiness signal to wait on, so these are the floor ---
TYPE_DELAY_MS=45      # per keystroke; fast synthetic typing drops characters in WebKit
FOCUS_SETTLE=0.5      # after a Tab, before looking at the focus ring
UI_SETTLE=1.5         # after a keystroke that changes screen
STABLE_INTERVAL=1.5   # poll gap for wait_stable
WAIT_APP=90           # window to appear after launch
BOOT_SETTLE=8         # window mapped -> wallet UI painted (wasm init, popup module)
# password submit -> setup step (register + PoW + bootstrap). Generous because
# registration can include an altcha proof-of-work solve, and this runs under
# software-rendered WebKit on a virtual display, where that JS is far slower
# than on a real GPU-backed browser. Override with WAIT_ONBOARD if a backend's
# PoW difficulty makes even this too tight.
WAIT_ONBOARD="${WAIT_ONBOARD:-900}"
WAIT_STABLE=45        # per surface, waiting for the frame to stop moving

# --- frame checks ---
# A real wallet frame has thousands of unique colours (text antialiasing alone).
# One colour means a blank window, the failure that wasted a week on the
# extension captures.
MIN_UNIQUE_COLORS=32
DIFF_FUZZ="8%"        # per-channel tolerance, so antialiasing is not a "change"
RING_PIXELS=250       # a focus ring around a 200px-wide nav row is ~900px; a badge is smaller
SAME_FRACTION=200     # two frames within 1/200 (0.5%) of the window are the same screen

# ============================================================================
# Args
# ============================================================================

usage() { sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; }

DRY_RUN=0
FORCE=0
KEEP_PROFILE=0
NO_WALLET=0
BACKEND=""
APPIMAGE="${SMIRK_APPIMAGE:-$APPIMAGE_DEFAULT}"
MNEMONIC_ENV="${SMOKE_MNEMONIC_ENV:-$MNEMONIC_ENV_DEFAULT}"
RESIZE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=1 ;;
    --force)        FORCE=1 ;;
    --keep-profile) KEEP_PROFILE=1 ;;
    --no-wallet)    NO_WALLET=1 ;;
    --backend)      BACKEND="${2:-}"; shift ;;
    --app)          APPIMAGE="${2:-}"; shift ;;
    --out)          OUT_DIR="${2:-}"; shift ;;
    --size)         RESIZE="${2:-}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; echo "try --help" >&2; exit 2 ;;
  esac
  shift
done

die() { echo; echo "FAILED: $*" >&2; exit 1; }

# Everything below runs after a `cd` into the scratch profile, so a relative path
# from the command line would resolve somewhere the caller did not mean (and, for
# the output directory, inside a tree this script deletes on exit).
absolutise() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
OUT_DIR="$(absolutise "$OUT_DIR")"
APPIMAGE="$(absolutise "$APPIMAGE")"
MNEMONIC_ENV="$(absolutise "$MNEMONIC_ENV")"

# ============================================================================
# Prerequisites. All checked before anything is launched, so --dry-run and the
# real run agree on what "ready" means.
# ============================================================================

problems=()
notes=()

# Notes are advisory, not blocking. A leading space marks a continuation line so
# a multi-line note reads as one paragraph rather than four shouted ones.
print_notes() {
  local n
  [ ${#notes[@]} -gt 0 ] || return 0
  for n in "${notes[@]}"; do
    case "$n" in
      " "*) echo "$n" ;;
      *)    echo "note: $n" ;;
    esac
  done
}

need() {                    # need <command> <why>
  command -v "$1" >/dev/null 2>&1 || problems+=("missing '$1' ($2)")
}

need Xvfb "the headless X server the app runs against"
need xdotool "window lookup and synthetic keyboard input"
need setsid "so the app and its WebKit helper processes can be killed as one group"

# ImageMagick 7 renames the tools; both layouts are in the wild.
if command -v magick >/dev/null 2>&1; then
  IM_IMPORT=(magick import); IM_IDENTIFY=(magick identify)
  IM_CONVERT=(magick);       IM_COMPARE=(magick compare)
elif command -v import >/dev/null 2>&1; then
  IM_IMPORT=(import); IM_IDENTIFY=(identify)
  IM_CONVERT=(convert); IM_COMPARE=(compare)
else
  IM_IMPORT=(false); IM_IDENTIFY=(false); IM_CONVERT=(false); IM_COMPARE=(false)
  problems+=("missing ImageMagick (import/identify/convert/compare)")
fi
# `compare` is a separate binary in some ImageMagick packages and it is not
# optional here: the blank-frame check, the duplicate-frame check and the focus
# walk are all built on it.
if [ "${IM_COMPARE[0]}" != "false" ] && ! "${IM_COMPARE[@]}" -version >/dev/null 2>&1; then
  problems+=("ImageMagick's 'compare' is not usable; every frame check depends on it")
fi

# The mnemonic is typed through xdotool's --file so it never appears in the
# process table. Without that flag the whole seed would be an argv on a box where
# anyone can run ps.
if command -v xdotool >/dev/null 2>&1; then
  # `xdotool type --help` needs an X display before it will print anything: with
  # no DISPLAY it dies with "Can't open display" and the grep below sees an empty
  # string, which reads as "--file is missing" when the flag is actually there.
  # Ask under a throwaway display so the answer is about xdotool rather than
  # about the environment this check happens to run in.
  xdotool_help=""
  if [ -n "${DISPLAY:-}" ]; then
    xdotool_help="$(xdotool type --help 2>&1 || true)"
  elif command -v xvfb-run >/dev/null 2>&1; then
    xdotool_help="$(xvfb-run -a xdotool type --help 2>&1 || true)"
  fi
  if [ -z "$xdotool_help" ]; then
    problems+=("could not ask xdotool whether 'type --file' exists (no display and no xvfb-run)")
  elif ! printf '%s' "$xdotool_help" | grep -q -- '--file'; then
    problems+=("this xdotool's 'type' has no --file: it would put the seed phrase in argv")
  fi
fi

[ -f "$APPIMAGE" ] || problems+=("no AppImage at $APPIMAGE")
if [ -f "$APPIMAGE" ] && [ ! -x "$APPIMAGE" ]; then
  problems+=("AppImage is not executable: chmod +x '$APPIMAGE'")
fi
# AppImages mount themselves with FUSE. Without /dev/fuse the runtime can still
# unpack itself, but only when told to.
if [ ! -e /dev/fuse ] && [ -z "${APPIMAGE_EXTRACT_AND_RUN:-}" ]; then
  notes+=("no /dev/fuse: if the AppImage refuses to start, re-run with APPIMAGE_EXTRACT_AND_RUN=1")
fi

WORDS=""
if [ "$NO_WALLET" -eq 0 ]; then
  if [ -z "${SMOKE_ALICE_MNEMONIC:-}" ]; then
    if [ -f "$MNEMONIC_ENV" ]; then
      # shellcheck disable=SC1090
      . "$MNEMONIC_ENV"
    else
      problems+=("no mnemonic: set SMOKE_ALICE_MNEMONIC or provide $MNEMONIC_ENV")
    fi
  fi
  if [ -n "${SMOKE_ALICE_MNEMONIC:-}" ]; then
    WORDS="$(printf '%s' "$SMOKE_ALICE_MNEMONIC" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
    count=$(printf '%s' "$WORDS" | wc -w | tr -d ' ')
    # The import screen has exactly 12 boxes (IMPORT_WORD_COUNT in
    # packages/ui/src/components/OnboardingWizard.tsx). A 24-word seed would type
    # 12 words into the boxes and the remaining 12 into the Continue button.
    [ "$count" -eq 12 ] || problems+=("SMOKE_ALICE_MNEMONIC has $count words; the import screen has 12 boxes")
  fi
fi

if [ -d "$OUT_DIR" ] && [ "$FORCE" -eq 0 ]; then
  existing=$(find "$OUT_DIR" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')
  [ "$existing" -eq 0 ] || problems+=("$existing PNG(s) already in $OUT_DIR; pass --force to replace them")
fi

# Window geometry has to fit on the virtual screen, because the capture reads the
# screen area the window covers.
scr_w=${XVFB_SCREEN%%x*}; scr_rest=${XVFB_SCREEN#*x}; scr_h=${scr_rest%%x*}
if [ -n "$RESIZE" ]; then
  case "$RESIZE" in
    [0-9]*x[0-9]*) ;;
    *) problems+=("--size wants WxH, got '$RESIZE'") ;;
  esac
  req_w=${RESIZE%%x*}; req_h=${RESIZE##*x}
  if [ "${req_w:-0}" -gt "$scr_w" ] || [ "${req_h:-0}" -gt "$scr_h" ]; then
    problems+=("--size $RESIZE does not fit the $XVFB_SCREEN virtual screen (set SMIRK_XVFB_SCREEN)")
  fi
fi

if [ -n "$BACKEND" ]; then
  case "$BACKEND" in
    https://*) ;;
    *) problems+=("--backend must be an https URL (the wallet's probe rejects anything else)") ;;
  esac
fi
if [ -z "$BACKEND" ] && [ -n "${SMOKE_BACKEND_URL:-}" ]; then
  notes+=("the smoke config names SMOKE_BACKEND_URL=$SMOKE_BACKEND_URL, which is where the")
  notes+=("      test wallet is registered and funded. The AppImage points at whatever backend")
  notes+=("      it was BUILT against, so if Home comes out with empty balances, re-run with")
  notes+=("      --backend $SMOKE_BACKEND_URL")
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo "prerequisites not met:"
  for p in "${problems[@]}"; do echo "  - $p"; done
  [ "$DRY_RUN" -eq 1 ] && { echo; echo "dry run: nothing was launched."; }
  exit 1
fi

# ============================================================================
# Dry run: report the plan and stop.
# ============================================================================

FRAMES=(00-first-run)
[ -n "$BACKEND" ] && FRAMES+=(07-self-host-backend)
[ "$NO_WALLET" -eq 0 ] && FRAMES+=(01-home-balances 04-swap 05-inbox 08-settings 10-browse)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "capture-desktop v$VERSION dry run: every prerequisite is present."
  echo
  echo "  app        $APPIMAGE"
  echo "  frames to  $OUT_DIR"
  echo "  X server   Xvfb, $XVFB_SCREEN, on the first free display >= :88"
  echo "  window     '$WINDOW_TITLE'${RESIZE:+, resized to $RESIZE}"
  echo "  profile    a fresh mktemp dir as XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME"
  if [ "$KEEP_PROFILE" -eq 1 ]; then
    echo "             KEPT on exit (--keep-profile), holding a keystore for the test seed"
  else
    echo "             deleted on exit, along with the keystore holding the test seed"
  fi
  if [ "$NO_WALLET" -eq 0 ]; then
    echo "  wallet     imports SMOKE_ALICE_MNEMONIC (12 words, read, not printed)"
    [ -n "$BACKEND" ] && echo "  backend    switches to $BACKEND before importing"
  else
    echo "  wallet     none (--no-wallet): stops after the Welcome screen"
  fi
  echo
  echo "would write:"
  for f in "${FRAMES[@]}"; do echo "  $f.png"; done
  echo
  echo "each frame is rejected if it has fewer than $MIN_UNIQUE_COLORS unique colours (a blank"
  echo "window) or if it is pixel-identical to a frame already captured this run (a"
  echo "navigation keystroke that did nothing)."
  echo
  print_notes
  echo
  echo "dry run: no X server started, no app launched, no keys typed."
  exit 0
fi

# ============================================================================
# Scratch profile, X server, app. Everything from here is torn down by the trap.
# ============================================================================

print_notes

PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/smirk-capture.XXXXXX")"
WORK="$PROFILE/work"
LOG="$PROFILE/app.log"
XLOG="$PROFILE/xvfb.log"
mkdir -p "$WORK" "$PROFILE/config" "$PROFILE/data" "$PROFILE/cache"

XVFB_PID=""
APP_PID=""
APP_PGID=""
DISPLAY_NUM=""

CLEANED=0
cleanup() {
  local rc=$?
  # exit inside a trap re-enters the EXIT trap; do the work once.
  [ "$CLEANED" -eq 1 ] && exit "$rc"
  CLEANED=1
  # A failed run's only evidence is the app log, and it lives in the profile
  # this function is about to delete. Rescue it into the output directory, which
  # survives, and say so: the operator is reading this over ssh.
  if [ "$rc" -ne 0 ] && [ -s "$LOG" ]; then
    mkdir -p "$OUT_DIR" 2>/dev/null || true
    if cp "$LOG" "$OUT_DIR/capture-app.log" 2>/dev/null; then
      echo "app log kept at $OUT_DIR/capture-app.log"
    fi
  fi
  # A GUI app that fails a navigation step usually logs nothing at all, so the
  # log rescue above comes back empty and the operator is left guessing at which
  # screen it actually stopped on. Photograph the display before tearing it
  # down: for a screenshot tool, the screen IS the diagnostic.
  if [ "$rc" -ne 0 ] && [ -n "$DISPLAY_NUM" ]; then
    mkdir -p "$OUT_DIR" 2>/dev/null || true
    if DISPLAY=":$DISPLAY_NUM" import -window root "$OUT_DIR/FAILED-screen.png" 2>/dev/null; then
      echo "screen at failure kept at $OUT_DIR/FAILED-screen.png"
    fi
  fi
  # The app first: WebKitGTK forks a web process and a network process, and
  # killing only the parent leaves them holding the display open.
  if [ -n "$APP_PGID" ]; then
    kill -TERM "-$APP_PGID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "-$APP_PGID" 2>/dev/null || break
      sleep 0.3
    done
    kill -KILL "-$APP_PGID" 2>/dev/null || true
  elif [ -n "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
  fi
  [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null || true
  # Xvfb leaves its lock behind if it is killed mid-write; only ever remove the
  # lock for the display this run created.
  [ -n "$DISPLAY_NUM" ] && rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true
  if [ "$KEEP_PROFILE" -eq 1 ]; then
    echo "profile kept at $PROFILE"
    echo "  it holds an encrypted keystore for the TEST SEED. Delete it when done."
  else
    # Guarded: only ever remove a directory this script made with mktemp.
    case "$PROFILE" in
      */smirk-capture.??????) rm -rf "$PROFILE" ;;
      *) echo "refusing to remove unexpected profile dir: $PROFILE" >&2 ;;
    esac
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# Own the X server rather than wrapping in xvfb-run: xvfb-run needs xauth (a
# separate package) and it would put the display's lifetime outside this trap.
for n in $(seq 88 120); do
  [ -e "/tmp/.X${n}-lock" ] && continue
  [ -e "/tmp/.X11-unix/X${n}" ] && continue
  DISPLAY_NUM="$n"; break
done
[ -n "$DISPLAY_NUM" ] || die "no free X display between :88 and :120"

echo "starting Xvfb on :$DISPLAY_NUM ($XVFB_SCREEN)"
Xvfb ":$DISPLAY_NUM" -screen 0 "$XVFB_SCREEN" -nolisten tcp >"$XLOG" 2>&1 &
XVFB_PID=$!
export DISPLAY=":$DISPLAY_NUM"
for _ in $(seq 1 40); do
  [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && break
  kill -0 "$XVFB_PID" 2>/dev/null || die "Xvfb exited immediately: $(tail -3 "$XLOG")"
  sleep 0.25
done
[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] || die "Xvfb never created its socket (see $XLOG)"

echo "launching $(basename "$APPIMAGE")"
# WebKitGTK's defaults assume a GPU and a compositor. Under Xvfb the DMABuf
# renderer and the accelerated compositor both produce a window that maps and
# then paints nothing, which is exactly the blank frame this script exists to
# avoid. Software GL + no compositing is the combination that renders.
cd "$PROFILE"     # an extract-and-run AppImage unpacks into the working directory
# The XDG trio is what keeps this off the operator's real wallet: Tauri resolves
# the plugin-store file under app_config_dir, and WebKit puts its local storage
# under the data dir, so both land in the scratch profile and every run starts
# from a wallet that does not exist yet. HOME is deliberately NOT moved: the
# AppImage runtime and glibc want a real one, and nothing wallet-shaped is
# written there.
setsid env \
  HOME="$HOME" \
  XDG_CONFIG_HOME="$PROFILE/config" \
  XDG_DATA_HOME="$PROFILE/data" \
  XDG_CACHE_HOME="$PROFILE/cache" \
  GDK_BACKEND=x11 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  "$APPIMAGE" >"$LOG" 2>&1 &
APP_PID=$!
sleep 0.5
# setsid does not fork when its caller is not a process-group leader, so $! is
# the app itself and its PGID is its own PID. Read it rather than assume it.
APP_PGID="$(ps -o pgid= -p "$APP_PID" 2>/dev/null | tr -d ' ' || true)"
[ -n "$APP_PGID" ] || APP_PGID="$APP_PID"

# ============================================================================
# Window, capture and frame checks
# ============================================================================

WID=""
WIN_X=0; WIN_Y=0; WIN_W=0; WIN_H=0

read_geometry() {           # read_geometry <window id>
  unset X Y WIDTH HEIGHT
  # `--shell` exists to be eval'd; it prints X=/Y=/WIDTH=/HEIGHT= assignments.
  eval "$(xdotool getwindowgeometry --shell "$1" 2>/dev/null || true)"
  WIN_X="${X:-0}"; WIN_Y="${Y:-0}"; WIN_W="${WIDTH:-0}"; WIN_H="${HEIGHT:-0}"
}

find_window() {
  local deadline id
  deadline=$(( $(date +%s) + WAIT_APP ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    kill -0 "$APP_PID" 2>/dev/null || {
      echo "--- last 30 lines of $LOG ---" >&2
      tail -30 "$LOG" >&2
      die "the app exited before it showed a window"
    }
    for id in $(xdotool search --onlyvisible --name "^$WINDOW_TITLE" 2>/dev/null || true); do
      read_geometry "$id"
      # WebKitGTK maps tiny utility windows too; the wallet window is at least
      # its configured minimum (380x600 in tauri.conf.json).
      if [ "$WIN_W" -ge 380 ] && [ "$WIN_H" -ge 600 ]; then WID="$id"; return 0; fi
    done
    sleep 0.5
  done
  echo "--- last 30 lines of $LOG ---" >&2
  tail -30 "$LOG" >&2
  die "no window titled '$WINDOW_TITLE' after ${WAIT_APP}s"
}

find_window
if [ -n "$RESIZE" ]; then
  # XResizeWindow works with no window manager running. The webview relays out
  # on the ConfigureNotify; the blank-frame check below is what catches it if the
  # surface does not survive.
  xdotool windowsize "$WID" "${RESIZE%%x*}" "${RESIZE##*x}"
  sleep 2
  read_geometry "$WID"
fi
echo "window $WID at ${WIN_X},${WIN_Y} size ${WIN_W}x${WIN_H}"
[ "$WIN_W" -gt 500 ] || die "window is only ${WIN_W}px wide; below 500 the UI switches to the
  bottom-nav popup layout and every keyboard route in this script is wrong"
if [ "$WIN_X" -lt 0 ] || [ "$WIN_Y" -lt 0 ] ||
   [ $((WIN_X + WIN_W)) -gt "$scr_w" ] || [ $((WIN_Y + WIN_H)) -gt "$scr_h" ]; then
  die "the window hangs off the $XVFB_SCREEN screen; captures would be garbage.
  Raise SMIRK_XVFB_SCREEN."
fi
SAME_TOL=$(( WIN_W * WIN_H / SAME_FRACTION ))

# A mapped window is not a rendered one. The webview paints the index.html
# background (a flat #0e0e10) while wasm and the popup module load, and a flat
# fill is perfectly STILL, so the stability check would happily photograph it and
# the blank-frame check would then reject a run that was only early. Sit out the
# boot instead.
sleep "$BOOT_SETTLE"

focus_app() {
  # windowfocus (XSetInputFocus) rather than windowactivate (EWMH), because
  # there is no window manager to answer an activate request. The pointer is
  # parked inside the window too, so a PointerRoot focus policy also lands here.
  xdotool windowraise "$WID" 2>/dev/null || true
  xdotool windowfocus "$WID" 2>/dev/null || true
  xdotool mousemove $((WIN_X + 4)) $((WIN_Y + 4)) 2>/dev/null || true
  sleep 0.2
}

key() {                     # key <keysym...>: one keystroke per call, to the focused window
  xdotool key --clearmodifiers "$@"
}

type_text() {               # type_text <string>
  # --file - keeps the text off the command line. The seed phrase is a live
  # secret on a box where anyone can read /proc.
  printf '%s' "$1" | xdotool type --clearmodifiers --delay "$TYPE_DELAY_MS" --file -
}

snap() {                    # snap <file.png>
  # -screen grabs the root-window area the window covers. Without it, X returns
  # the window's own (undefined, uncomposited) drawable and the result is noise.
  rm -f "$1"
  "${IM_IMPORT[@]}" -window "$WID" -screen "$1" 2>>"$LOG" || true
  [ -s "$1" ] || die "the screen grab wrote nothing to $1. Either the window went
  away or this ImageMagick has no X11 delegate (an 'import' built without X
  cannot capture anything). Tail of $LOG:
$(tail -5 "$LOG")"
}

crop_sidebar() {            # crop_sidebar <src.png> <dst.png>
  "${IM_CONVERT[@]}" "$1" -crop "${SIDEBAR_W}x${WIN_H}+0+0" +repage "$2"
}

unique_colors() {           # unique_colors <file.png>
  "${IM_IDENTIFY[@]}" -format '%k' "$1"
}

diff_pixels() {             # diff_pixels <a.png> <b.png> -> differing pixels, or -1
  local out rc=0
  out=$("${IM_COMPARE[@]}" -metric AE -fuzz "$DIFF_FUZZ" "$1" "$2" null: 2>&1) || rc=$?
  # compare exits 1 merely because the images differ; only >= 2 is a real error.
  [ "$rc" -ge 2 ] && { printf '%s\n' -1; return 0; }
  out=${out%%[ (]*}
  case "$out" in ''|*[!0-9.eE+-]*) printf '%s\n' -1; return 0 ;; esac
  printf '%.0f\n' "$out"
}

# Wait for the window to stop changing. This is the closest thing to a readiness
# signal available without the DOM: the bootstrap screen animates (the mining
# doge), so the frame only goes still once the app has moved on to something
# static. Times out rather than failing, because a permanently animated surface
# is a real possibility and the caller decides whether that is fatal.
wait_stable() {             # wait_stable <seconds>
  local deadline a="$WORK/stable-a.png" b="$WORK/stable-b.png" d
  deadline=$(( $(date +%s) + $1 ))
  snap "$a"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$STABLE_INTERVAL"
    snap "$b"
    d=$(diff_pixels "$a" "$b")
    [ "$d" -ge 0 ] || die "ImageMagick could not compare two captures; see $LOG"
    [ "$d" -le "$SAME_TOL" ] && return 0
    mv "$b" "$a"
  done
  return 1
}

CAPTURED=()
capture() {                 # capture <frame-name>
  local name="$1" file="$OUT_DIR/$1.png" k prev d
  wait_stable "$WAIT_STABLE" ||
    echo "  note: $name never went still in ${WAIT_STABLE}s; capturing anyway (expect a spinner)"
  snap "$file"
  k=$(unique_colors "$file")
  case "$k" in ''|*[!0-9]*) die "could not read a colour count from $file" ;; esac
  [ "$k" -ge "$MIN_UNIQUE_COLORS" ] ||
    die "$name.png has $k unique colour(s), which is a blank window, not a wallet.
  The frame is left in place for inspection. Check $LOG for a WebKit renderer
  error, and see the WEBKIT_DISABLE_* variables this script sets."
  if [ ${#CAPTURED[@]} -gt 0 ]; then
    for prev in "${CAPTURED[@]}"; do
      d=$(diff_pixels "$prev" "$file")
      [ "$d" -ge 0 ] || die "ImageMagick could not compare $prev and $file"
      [ "$d" -gt "$SAME_TOL" ] ||
        die "$name.png is the same screen as $(basename "$prev"): a navigation keystroke
  did nothing, so this frame would ship under the wrong name. Both files are left
  in place for inspection."
    done
  fi
  CAPTURED+=("$file")
  echo "  wrote $name.png ($k colours)"
}

mkdir -p "$OUT_DIR"

# ============================================================================
# Onboarding, keyboard only.
#
# Every step below is a Tab count through a screen whose focusable elements are
# fixed and few, read off packages/ui/src/components/OnboardingWizard.tsx. When a
# step unmounts, the focused element goes with it and focus falls back to the
# document body, which is what makes each count start from a known place.
# ============================================================================

focus_app
echo "capturing:"
capture 00-first-run

if [ "$NO_WALLET" -eq 1 ]; then
  echo
  echo "--no-wallet: stopped after the Welcome screen."
  echo "frames in $OUT_DIR"
  exit 0
fi

# Optional backend switch, BEFORE the wallet exists. Welcome's focusables are
# [Create new wallet] [Import existing] [Running your own backend?].
if [ -n "$BACKEND" ]; then
  echo "  switching backend to $BACKEND"
  focus_app
  key Tab; key Tab; key Tab; key Return
  sleep "$UI_SETTLE"
  # BackendPicker: [Back] [url input] [Connect (disabled until the input is
  # non-empty)] and, after a successful probe, [Use this backend].
  key Tab; key Tab
  type_text "$BACKEND"
  key Return                      # the input's own Enter handler runs the probe
  wait_stable "$WAIT_STABLE" || true
  capture 07-self-host-backend
  # Connect is focusable again now the probe has finished, so the Use button is
  # two Tabs on. HONEST LIMIT: a probe that FAILED renders an error box and no
  # Use button, and this script cannot tell the two apart by pixels. The frame
  # just captured shows which happened, so look at it: if it shows an error, the
  # run continued on the app's built-in default backend.
  key Tab; key Tab; key Return
  sleep "$UI_SETTLE"
fi

echo "  importing the test wallet"
focus_app
key Tab; key Tab; key Return      # Welcome -> Import existing
sleep "$UI_SETTLE"
key Tab; key Tab; key Return      # Before you import -> [Back] [Continue]
sleep "$UI_SETTLE"

# Import screen: [Back] then the 12 word boxes in DOM order, then [Continue].
# Deliberately NOT captured, at any point after this line and before Home: a
# frame of this screen would publish the smoke wallet's seed phrase into a
# marketing folder.
key Tab; key Tab
for w in $WORDS; do
  type_text "$w"
  key Tab                         # box 11's Tab lands on Continue
done
key Return
sleep "$UI_SETTLE"

# Password screen: the first field carries autoFocus and it is the first
# autofocus candidate this document has ever had, so it holds the caret. The
# confirm field submits on Enter.
type_text "$PASSWORD"
key Tab
type_text "$PASSWORD"
key Return

echo "  registering and bootstrapping (up to ${WAIT_ONBOARD}s)"
# The submitting screen animates, so "the frame went still" means it has been
# replaced by the setup step.
wait_stable "$WAIT_ONBOARD" ||
  die "the wallet never finished registering. Likely causes, in the order worth
  checking: no route to the backend; a backend that gates registration behind an
  invite or a payment, which this script does not drive; or the password screen
  never took the typing, which happens if the webview did not honour the field's
  autofocus and the keystrokes went to the document body. See $LOG."

# Set up Smirk: [@handle input] [Reserve (disabled)] [inject checkbox] [finish].
# The handle section is replaced by a "Welcome back" panel when the backend
# already knows this seed, and that removes a focusable, so the finish button is
# either two or three Tabs away. Probe for it rather than guess: type one
# character into whatever the first Tab landed on and see whether the screen
# reacts. A character in the handle field trips the client-side validation hint,
# which is a whole line of new text; a character aimed at a checkbox does
# nothing. The baseline is taken AFTER the Tab so the focus ring is in both
# frames and only the typing can move the needle.
#
# One character, deliberately: the Reserve button stays disabled below three, and
# a disabled button is not in the tab order. And nothing here reserves anything.
# The finish button only persists the inject choice and continues
# (SmirkSetup.submitAndContinue), so the probe character is discarded.
setup_a="$WORK/setup-a.png"; setup_b="$WORK/setup-b.png"
key Tab
sleep "$FOCUS_SETTLE"
snap "$setup_a"
type_text "x"
sleep "$FOCUS_SETTLE"
snap "$setup_b"
d=$(diff_pixels "$setup_a" "$setup_b")
[ "$d" -ge 0 ] || die "ImageMagick could not compare the setup-step probe frames"
if [ "$d" -gt "$RING_PIXELS" ]; then
  echo "  setup step: handle field present, skipping it"
  key Tab; key Tab                # -> inject checkbox -> finish
else
  echo "  setup step: no handle field (the backend already knows this seed)"
  key Tab                         # -> finish
fi
key Return
sleep "$UI_SETTLE"

echo "  waiting for Home"
wait_stable "$WAIT_ONBOARD" ||
  echo "  note: Home never went still; balances or prices may still be loading"
# If the wizard is still on screen we would be about to capture the setup step
# under the name of the Home frame, which is worse than failing.
snap "$WORK/home-check.png"
d=$(diff_pixels "$setup_b" "$WORK/home-check.png")
[ "$d" -ge 0 ] || die "ImageMagick could not compare the post-setup frames"
[ "$d" -gt "$SAME_TOL" ] ||
  die "the screen after the setup step is the setup step: onboarding did not
  finish, so there is no Home to photograph. See $LOG."

capture 01-home-balances
HOME_FRAME="$OUT_DIR/01-home-balances.png"

# ============================================================================
# The tab bar.
#
# Two facts make this safe. The sidebar precedes <main> in the DOM, so the tabs
# are the first focusables in the document; and the sidebar is a fixed 200px
# column, so a crop of it shows where the keyboard focus ring is without any
# knowledge of what the tab body contains. Enter is only ever pressed on a
# position that has been shown to be inside that column.
# ============================================================================

nav_anchor() {
  local i probe d
  focus_app
  for i in $(seq 1 "$NAV_HOME_TABS"); do key Tab; done
  sleep "$FOCUS_SETTLE"
  # Home is already the open tab, so activating it must change nothing. Anything
  # else in reach changes the screen: the identity switcher opens a menu, and a
  # neighbouring tab swaps the whole body. Both are harmless to press, which is
  # why this probe is allowed to be a keystroke at all.
  key Return
  wait_stable "$WAIT_STABLE" || true
  probe="$WORK/anchor-probe.png"
  snap "$probe"
  d=$(diff_pixels "$HOME_FRAME" "$probe")
  [ "$d" -ge 0 ] || die "ImageMagick could not compare the anchor probe"
  [ "$d" -le "$SAME_TOL" ] || die "the nav anchor is wrong: $NAV_HOME_TABS Tabs from the
  document body did not land on the Home tab (the screen changed when it should
  not have). The sidebar header's focusable buttons are what this count encodes;
  the refresh button disappears from the tab order while a refresh is in flight,
  and the identity switcher does not render until it has loaded. Look at
  $probe, then adjust NAV_HOME_TABS at the top of this script."
}

# Walk the focus ring down the sidebar to find the LAST tab. The tab list is not
# fixed: Feed appears only when the backend advertises one, and Browse only on
# desktop. Counting from the end is what makes Settings and Browse identifiable
# whether or not Feed is there.
#
# The walk runs on HOME on purpose. It needs a tab body with at least two
# focusable elements after the nav (Home has the balance, the hide toggle, the
# action row and a row per asset), because the stop condition is two consecutive
# Tabs that leave the sidebar untouched.
#
# Counting: every press that changes the sidebar is either a hop between two nav
# rows or the ring LEAVING the last row, and that last one changes the column
# too. So the number of nav tabs after Home is one less than the number of
# changing presses, and getting back to the last tab takes two Shift+Tabs.
NAV_LAST=0
nav_walk() {
  local prev="$WORK/nav-prev.png" cur="$WORK/nav-cur.png" full="$WORK/nav-full.png"
  local moves=0 left=0 d
  snap "$full"; crop_sidebar "$full" "$prev"
  while [ "$moves" -lt "$MAX_NAV_TABS" ]; do
    key Tab
    sleep "$FOCUS_SETTLE"
    snap "$full"; crop_sidebar "$full" "$cur"
    d=$(diff_pixels "$prev" "$cur")
    [ "$d" -ge 0 ] || die "ImageMagick could not compare two sidebar crops"
    if [ "$d" -lt "$RING_PIXELS" ]; then left=1; break; fi
    moves=$(( moves + 1 ))
    mv "$cur" "$prev"
  done
  [ "$left" -eq 1 ] || die "the focus ring never stopped moving in the sidebar after
  $MAX_NAV_TABS presses. Something in that column is repainting on its own: the
  refresh button spins while a balance refresh is in flight, and the Inbox badge
  counts pending items. Re-run; if it persists, raise RING_PIXELS so a spinner
  does not read as a focus move."
  # home, swap, inbox, settings, browse is the floor, so 4 hops plus the press
  # that leaves the column. Fewer means the ring was never visible, and every
  # Enter after this point would be blind.
  [ "$moves" -ge 5 ] || die "only $moves sidebar changes while walking the tab bar, expected
  at least 5 (Swap, Inbox, Settings, Browse, then the press that leaves the
  column). Either the focus ring is not being drawn, in which case this script
  cannot navigate safely and will not guess, or the Browse tab is missing because
  the desktop shell failed to install its browser controller (see $LOG). Lower
  RING_PIXELS if the ring is drawn thinner than this assumes."
  NAV_LAST=$(( moves - 1 ))
  # Two presses past the last tab, both of them inside the tab body. Step back.
  key shift+Tab
  key shift+Tab
  sleep "$FOCUS_SETTLE"
}

NAV_POS=0
nav_focus() {               # nav_focus <index, 0 = Home>
  local delta=$(( $1 - NAV_POS ))
  # Paced: a dropped focus move would shift every frame that follows onto the
  # wrong tab, and 0.15s per press is nothing against the settle times.
  while [ "$delta" -gt 0 ]; do key Tab; sleep 0.15; delta=$(( delta - 1 )); done
  while [ "$delta" -lt 0 ]; do key shift+Tab; sleep 0.15; delta=$(( delta + 1 )); done
  NAV_POS="$1"
  sleep "$FOCUS_SETTLE"
}

nav_open() {                # nav_open <index> <frame-name>
  nav_focus "$1"
  key Return
  sleep "$UI_SETTLE"
  capture "$2"
}

nav_anchor
nav_walk
NAV_POS="$NAV_LAST"

# Named from the END for Settings and Browse (position is stable whether or not
# the backend advertises a Feed tab) and from the START for Swap and Inbox, which
# always sit at 1 and 2. Browse goes last on purpose: the embedded browser mounts
# an iframe that can take the focus with it, and nothing needs the tab bar after.
nav_open $(( NAV_LAST - 1 )) 08-settings
nav_open 2 05-inbox
nav_open 1 04-swap
nav_open "$NAV_LAST" 10-browse

# ============================================================================
# Report
# ============================================================================

echo
echo "${#CAPTURED[@]} frames in $OUT_DIR"
echo
echo "LOOK AT THEM BEFORE USING THEM. This script drives the app blind: it cannot"
echo "read the DOM, so it verifies that each frame is a real, distinct, non-blank"
echo "window and nothing more. It cannot tell you that Home shows funded balances"
echo "rather than zeros, or that a tab finished loading before the shutter."
echo
echo "no desktop counterpart to the extension's 02-receive-xmr, 03-send-btc,"
echo "06-nostr-identity or 09-connected-sites: those are drill-downs behind"
echo "in-content controls, and this script will not press Enter on an element it"
echo "cannot identify while a funded wallet is open. See the header comment."
echo
echo "these land in raw/<variant> alongside the extension's raw/popup and"
echo "raw/phone. make-store-shots.mjs will not composite them until it has a"
echo "TARGET whose src is 'desktop' and a CAPTIONS entry per frame name; without"
echo "those it does not read this directory at all."
