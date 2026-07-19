# @smirk/e2e — end-to-end suite (the client-release gate)

Playwright drives the **real MV3 browser extension** (headless Chromium) against a
**running backend**. This is the release gate: it exercises the actual popup +
background service worker + offscreen document as a user would, catching
extension↔backend integration bugs that unit tests can't see. (It has already
caught three — see _Bugs this suite caught_ below.)

## Run it

```bash
# 0. one-time: install browsers
npx playwright install chromium

# 1. a backend must be up. Default target: http://127.0.0.1:8080/api/v1
#    (a local smirk-backend-core). Point elsewhere with BACKEND_URL.

# 2. the funded smoke seeds must be sourced (returning-user specs skip without them)
set -a; source packages/smoke-tests/secrets/smoke-mnemonics.env; set +a   # SMOKE_ALICE_MNEMONIC, …

# 3. build the extension against that backend, then run
npm run e2e -w @smirk/e2e            # = build:ext (ui+ext) + playwright test
# or, if the dist is already fresh:
npm run test -w @smirk/e2e
HEADED=1 npm run test -w @smirk/e2e  # watch it drive a visible window
```

`build:ext` (`scripts/build-extension.sh`) compiles the workspace libs
(`@smirk/assets` → `@smirk/core` → `@smirk/ui`) then `vite build`s the extension
with the backend baked in. **Editing a testid in `@smirk/ui` has no effect until
you rebuild** — the extension bundles ui's `dist/`, not its source.

### Env

| var | default | note |
| --- | --- | --- |
| `BACKEND_URL` | `http://127.0.0.1:8080/api/v1` | what the specs talk to; **must include `/api/v1`** |
| `VITE_SMIRK_BACKEND_URL` | `http://127.0.0.1:8080/api/v1` | baked into the build (same value) |
| `VITE_SMIRK_API_STYLE` | `namespaced` | wallet dialect; smirk-backend-core is `namespaced`, legacy is `flat` |
| `EXTENSION_DIST` | `packages/extension/dist` | override to load a different build |
| `HEADED` | _(unset)_ | `1` → visible browser |
| `CAPTURE_VIDEO` | _(unset)_ | `1`/`on` records EVERY test (not just failures) for demo capture; see below |
| `CAPTURE_VIDEO_DIR` | `packages/e2e/videos/` | where recordings land |
| `CAPTURE_VIDEO_W` / `CAPTURE_VIDEO_H` | `420` / `900` | capture viewport (mobile-portrait default) |

## Two hard rules (learned the hard way)

1. **Never wait on offscreen network.** Bootstrap-auth (`POST /auth/extension`)
   and the whole register/checkRestore pipeline run in the extension's
   **offscreen document**, whose traffic is **invisible** to Playwright's
   page/context response listeners. `waitForResponse('/auth/extension')` there
   **always** times out. Detect auth by a **capturable** signal instead — a real
   backend balance rendering on Home. `fixtures/onboard.ts` `importAndUnlock`
   encapsulates this.
2. **Assert on capturable UI, not offscreen effects.** Balances, headings,
   testids, nav state — all fine (they originate from the popup page). Offscreen
   side effects are not directly observable; assert on their UI consequence.

## Self-adapting to operator config

Some scenarios need a specific backend config. Rather than hard-code an
assumption, they read `GET /capabilities` (`fixtures/capabilities.ts`) and
`test.skip` when the running instance doesn't match — so **one suite run adapts
to whatever backend is up**:

| spec | runs only when |
| --- | --- |
| `pay-to-register` | `registration.payment_required === true` |
| `create-new-wallet` | `payment_required === false && invite_required === false` |
| `nostr-identity` | `features.nostr_identity === true` |
| `restore-with-height` | branches on `restore.policy` |

`pay-to-register` and `create-new-wallet` are **mirror images** (payment gate
on vs off), so at most one runs per config; the other skips cleanly.

## Scenarios

| spec | what it proves | needs |
| --- | --- | --- |
| `onboarding` | fresh popup renders the welcome/onboarding surface | — |
| `onboarding-import` | import alice → auth → **real backend balances** render | alice seed |
| `receive` | Home → Receive → pick XMR → a real client-derived address + copy | alice seed |
| `settings-and-inbox` | nav to Settings + Inbox, surfaces render (daemon-free) | alice seed |
| `send-compose-xmr` | Send → XMR → address+amount → reach Review (no broadcast) | alice seed |
| `swap` | Swap wizard → Trocador → reach a quote | alice seed |
| `tip-share-url` | public tip → claimable share URL | alice seed |
| `restore-with-height` | import + restore-height per `restore.policy` | alice seed |
| `create-new-wallet` | generate → answer verify challenge → register → Home | open registration |
| `pay-to-register` | fresh wallet is **blocked** by the payment gate | payment gate on |
| `nostr-identity` | Settings → Nostr link/login identity screen | `nostr_identity` on |
| `grin-send-nostr` | Grin Send accepts an npub + a NIP-05 name as recipient (routes over gift-wrap, not slatepack) → advances to amount | alice seed, grin on |
| `goblin-paylink` | pasting a `goblin:` checkout URI pre-fills the Grin Send flow (npub → pubkey, amount from the link) | alice seed, grin on |
| `session-cache-restore` | reopening the popup restores from the session cache — no re-onboard, no key/offscreen sign-in error | alice seed |
| `feed` | Feed tab is present + renders **iff** the backend advertises `features.feed` (absent otherwise) | alice seed |
| `balance-freshness-cue` | the freshness affordance escalates on **sustained** refresh failure (quiet, then amber >30s, then red >60s) and clears once a refresh succeeds | alice seed |
| `send-fee-btc` | regression guard: against a **namespaced** backend the BTC/LTC fee estimate populates the Compose fee tiers so "Continue to review" enables | alice seed |
| `dapp-payment` | drives the **real** dapp payment popup: a shop calls `requestPayment` with a human decimal (`"9"` WOW); approval shows `9 WOW`, never "atomic units" | alice seed |
| `messaging-inbox-identity` | Nostr identity overhaul nav smoke (daemon-free): the identity switcher + messaging→Inbox merge (Phases 4-6) | alice seed |
| `tip-claim` | claim a **public** (URL-shared) tip end to end via the real Inbox → "+ Paste tip link" entry point | alice seed |
| `tip-grin-share` | create a **public Grin voucher** tip and land on the success screen in its `shareUrlPending` state | alice seed, grin on |

## Demo capture (`CAPTURE_VIDEO`)

`CAPTURE_VIDEO=1` (or `on`/`true`/`yes`) records **every** test's popup,
approval window, and dapp page, not just failures, so an e2e run doubles as
demo-clip capture. Recordings land in `CAPTURE_VIDEO_DIR` (default
`packages/e2e/videos/`) at a **mobile-portrait** viewport (420×900, override with
`CAPTURE_VIDEO_W` / `CAPTURE_VIDEO_H`). Default runs stay lean: on-failure only.

```bash
CAPTURE_VIDEO=1 npm run test -w @smirk/e2e            # capture all specs
CAPTURE_VIDEO=1 npm run test -w @smirk/e2e -- dapp-payment   # just the payment popup clip
```

## Not yet covered (needs infra)

- **Real broadcast sends** and the **live pay-to-register settle** (pay an invoice
  → register) need the chain-daemon tunnels up. The suite currently reaches
  Send→Review and asserts the payment *gate*, not an on-chain broadcast.
- **Tauri desktop** shell under Playwright (Phase 3).
