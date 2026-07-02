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

## Not yet covered (needs infra)

- **Real broadcast sends** and the **live pay-to-register settle** (pay an invoice
  → register) need the chain-daemon tunnels up. The suite currently reaches
  Send→Review and asserts the payment *gate*, not an on-chain broadcast.
- **Tauri desktop** shell under Playwright (Phase 3).
