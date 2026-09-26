#!/usr/bin/env bash
# Install rustup into this job's own CARGO_HOME without editing shell profiles.
#
# dtolnay/rust-toolchain installs rustup when none is on PATH, and on
# non-Windows runners it does so without --no-modify-path. rustup-init then
# appends `. "$CARGO_HOME/env"` to the runner user's ~/.profile, ~/.bashrc and
# ~/.zshenv. Our CARGO_HOME is job-scoped under runner.temp, so on a host-mode
# runner every job left a line pointing at a directory deleted when the job
# ended, and every later shell on the host printed an error for each one.
# Installing rustup here first, into the same home and without touching any
# profile, makes the action's `command -v rustup` probe succeed, so it only
# selects the toolchain.
set -euo pipefail

if command -v rustup >/dev/null 2>&1; then
  echo "rustup already on PATH at $(command -v rustup); toolchains go to ${RUSTUP_HOME:-its default home}"
  exit 0
fi

# Installing is the only case that needs a job-scoped home to install into.
for name in CARGO_HOME RUSTUP_HOME GITHUB_PATH; do
  if [ -z "${!name:-}" ]; then
    echo "$name is unset: set job-scoped CARGO_HOME and RUSTUP_HOME in the job env before this step" >&2
    exit 1
  fi
done

curl --proto '=https' --tlsv1.2 --retry 10 --retry-connrefused --location \
  --silent --show-error --fail https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain none --no-modify-path
echo "$CARGO_HOME/bin" >>"$GITHUB_PATH"
echo "installed rustup in $CARGO_HOME without editing shell profiles"
