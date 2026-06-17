#!/bin/sh
# Cron-deployable smoke runner.
#
# Designed for the tipbot server. Pulls latest monorepo, builds the
# smoke-tests workspace, runs it. Discord notifications go out per
# the SMOKE_DISCORD_WEBHOOK_URL in /etc/smirk-smoke.env. Exit code
# 0 = green, 1 = at least one scenario failed.
#
# Recommended cron schedule (hourly):
#   0 * * * * /opt/smirk-monorepo/packages/smoke-tests/scripts/run-cron.sh \
#     >> /var/log/smirk-smoke.log 2>&1
#
# Or as a systemd timer (preferred — `journalctl -u smirk-smoke`
# captures stdout/stderr automatically and `OnFailure=` can chain
# extra alerts):
#
#   /etc/systemd/system/smirk-smoke.service:
#     [Unit]
#     Description=Smirk wallet-to-wallet smoke
#     [Service]
#     Type=oneshot
#     EnvironmentFile=/etc/smirk-smoke.env
#     ExecStart=/opt/smirk-monorepo/packages/smoke-tests/scripts/run-cron.sh
#     User=smirk
#
#   /etc/systemd/system/smirk-smoke.timer:
#     [Unit]
#     Description=Run smirk smoke hourly
#     [Timer]
#     OnCalendar=hourly
#     Persistent=true
#     [Install]
#     WantedBy=timers.target

set -eu

cd "$(dirname "$0")/../.."  # → smoke-tests/
cd ../..                     # → repo root

# Optional: refresh from git. Comment out if you deploy by other means.
# git fetch --quiet origin main && git reset --quiet --hard origin/main

# Install workspace deps (cheap when up-to-date; npm dedupes).
npm install --no-audit --no-fund --silent

# Run via tsx — no build step needed. tsx handles TypeScript +
# Node ESM extension resolution (sidesteps the directory-import
# issue in @smirk/core's compiled dist). The smoke runner does its
# own try/catch + Discord post; the exit code propagates so cron /
# systemd record the verdict.
npm run smoke -w @smirk/smoke-tests
