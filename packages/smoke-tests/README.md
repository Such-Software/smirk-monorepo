# @smirk/smoke-tests

Two-wallet automated smoke harness. Boots Alice + Bob `@smirk/core` clients from BIP-39 mnemonics in env, dispatches scenarios against production, posts a single Discord summary.

Lives in `STRUCTURAL_DEBT.md` headline ("wallet-to-wallet integration tests") — phase 1 of the deliverable described there.

## What this catches today (phase 1)

- **Auth flow regressions.** Both wallets must boot, run `bootstrapAuth`, and get a JWT. Hits `is_returning_user`, `checkRestore`, `extensionRegister`. A backend deploy that breaks any of these fails every scenario.
- **Balance endpoint regressions.** `getBalances` for both wallets across BTC/LTC/XMR/WOW. Discord posts the numbers on every run so balance drift is visible.
- **Tip state-machine drift.** `tip-draft-cycle` creates a draft, asserts it surfaces in `getSentSocialTips` with `status='draft'` and the right amount, then cancels it and asserts the transition to `'cancelled'`. Would catch the kind of UI/backend status drift that surfaced as ship-blockers T1 + T2 in the 2026-06-13 tip audit, even without on-chain broadcast.
- **encrypted_key cap regression.** The cap (4 KB hex) shipped in v0.3.0.1 is exercised every run — if the cap moves or the create_social_tip handler regresses on body parsing, the draft creation fails.

## What's coming next (phase 2)

- **Funded BTC tip happy path.** Alice broadcasts a real funding tx, calls `attachSocialTipFunding`, polls the verifier, asserts `funding_amount_verified=TRUE`, Bob calls `getClaimableTips`, decrypts the encrypted_key with his BTC privkey, sweeps the tip address. Catches T3, the verifier's full BTC/LTC `get_history` path, and the sender DM on funding_mismatch.
- **Funding-mismatch flow.** Alice declares 1000 sat but funds 500 — assert verifier flips to `funding_mismatch`, Alice gets sender DM, Bob CANNOT claim, Alice CAN clawback.
- **Public-tip URL claim.** Alice creates public tip + share URL, Bob extracts the URL fragment, derives the spend key, claims. Catches the public-tip claim path + the encrypted_key URL-fragment crypto.
- **Trocador swap quote → deposit.** Alice gets a quote, confirms, broadcasts the deposit, polls the swap to terminal. Catches the swap webhook auth + verifier-stamp regression.

The blocker for phase 2 is that tip-key crypto (`encryptTipKey`, `decryptTipKey`, tip-address spend-key derivation) lives in `packages/extension/src/popup/tip-handler.ts` and isn't exposed by `@smirk/core`. The structural follow-up is to promote that crypto into `@smirk/core` so both the extension and the smoke harness reuse the same code — captured in `docs/STRUCTURAL_DEBT.md` § "wallet-to-wallet integration tests."

## Local development

```sh
# From the monorepo root
npm install                          # only needed once
npm run build -w @smirk/wasm \
             -w @smirk/assets \
             -w @smirk/core \
             -w @smirk/smoke-tests
cd packages/smoke-tests
cp .env.example .env                 # then fill in real values
node --env-file=.env dist/main.js    # or: SMOKE_DRY_RUN=1 npm run smoke:dev
```

`SMOKE_DRY_RUN=1` short-circuits scenarios that would broadcast on-chain — useful while iterating.

## Production deployment (tipbot server)

The cron-friendly wrapper at `scripts/run-cron.sh` builds + runs in one shot. Recommended systemd timer (also documented in the script header):

```sh
# 1. Pull the latest monorepo into /opt/smirk-monorepo (you can sync from anywhere)
# 2. Drop env file at /etc/smirk-smoke.env:
#      SMOKE_BACKEND_URL=https://api.smirk.cash
#      SMOKE_ALICE_MNEMONIC="…"
#      SMOKE_BOB_MNEMONIC="…"
#      SMOKE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
# 3. Install /etc/systemd/system/smirk-smoke.service + .timer (see script header)
# 4. systemctl daemon-reload && systemctl enable --now smirk-smoke.timer
```

Logs land in `journalctl -u smirk-smoke`. Failures fire Discord; the timer's `OnFailure=` can chain extra alerts if you want.

## Provisioning the test wallets

Each test wallet needs:

1. A fresh BIP-39 mnemonic (use the extension's "Create wallet" or any standard generator).
2. One-time registration with the production backend — open the extension once with the mnemonic, let bootstrap auth + PoW solve run. Subsequent smoke runs hit the `is_returning_user` bypass and skip the PoW.
3. Small funding ($5-10 of BTC, LTC, XMR, WOW) sent to the wallet's derived addresses. The phase-2 funded scenarios will burn ~1k sat per tip; the health-check + draft-cycle phase-1 scenarios don't move on-chain funds at all.

Store the mnemonics in `/etc/smirk-smoke.env` with `chmod 600` and a service-user `EnvironmentFile=` directive — never commit them to git.

## Adding a new scenario

```ts
// src/scenarios/my-scenario.ts
import type { Scenario } from './types';

export const myScenario: Scenario = {
  name: 'my-scenario',
  async run(env) {
    // env.alice / env.bob / env.backendUrl available.
    // Throw to fail; return (with optional `context`) to pass.
  },
};
```

Then add it to the `SCENARIOS` array in `src/main.ts`. Discord summary picks it up automatically.

Keep scenarios **idempotent** (re-runs don't accumulate state) and **independent** (one scenario's success/failure doesn't affect the next). The harness runs them in declaration order; a failing scenario doesn't abort the rest.
