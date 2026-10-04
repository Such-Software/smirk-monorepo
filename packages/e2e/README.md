# Wallet browser integration tests

> Status: active · Updated 2026-09-27 · Applies to: Smirk client source

Playwright drives the real MV3 extension against an explicitly selected backend.
The suite supplies release evidence for the scenarios that execute. It does not
prove live chain behavior, desktop integration or store readiness by itself.
The active Gitea unit workflow excludes this package. Historical GitHub E2E
workflows are not evidence that the current release passed browser integration.

## Run the fundless release check

Use a disposable local `smirk-backend-core` instance with its own PostgreSQL
database. Allow unfunded registration, disable payment/invite gates and external
chain services, and generate its authentication secrets in the launching process.
The backend must not load a production `.env`. Runtime-generated values remain
in child-process environment or memory, never command arguments or output.

```sh
npx playwright install chromium

# Build and test against the same local API. The API mount is required.
VITE_SMIRK_BACKEND_URL=http://127.0.0.1:8080/api/v1 npm run build:ext -w @smirk/e2e
BACKEND_URL=http://127.0.0.1:8080/api/v1 E2E_MIN_EXECUTED=1 \
  npm run test -w @smirk/e2e -- tests/fundless-release-review.spec.ts
```

`fundless-release-review` generates a fresh phrase and password at runtime,
registers against the real local backend, verifies the coin-detail Send shortcut,
checks password-setting cancellation and wrong-password refusal, reopens the
wallet within its grace period, and checks that Lock revokes another open window.
It neither imports a funded wallet nor broadcasts a transaction. A focused pass
proves this scenario only; the explicit execution floor is not the full-suite gate.

`build:ext` builds workspace dependencies before bundling the extension. Changes
to UI test IDs need a rebuild. Preflight checks that the bundle targets the same
backend as the tests and that its capabilities endpoint answers. A network error
or wrong build refuses; it does not become a skipped success.

## Secret output policy

Capture is closed for the wallet suite, including failed tests:

- Trace, screenshots and video are off. CLI and per-test capture overrides refuse.
- Accessibility snapshots are suppressed, and error values/call logs are sanitized
  before failure artifacts are built. A generated phrase can appear in a DOM
  snapshot even when the screenshot setting is off.
- The private reporter prints source locations and outcomes. It does not forward
  browser stdout, assertion values, attachments, steps or HTML reports.
- Footage markers retain no values, URLs or sidecar files. `CAPTURE_VIDEO` and
  `MARKETING_SHOTS` no longer activate capture. The old marketing spec stays closed.
- Debug logging and generic reporter overrides refuse because they can print
  inputs or authentication values. `HEADED=1` remains available for local observation.

Do not paste phrases, passwords, tokens or keys into shell commands, assertions,
test titles, console logs, screenshots or reports. Never source a secret-bearing
file for an ordinary fundless run. Existing returning-wallet scenarios require a
separately authorized credential injection procedure; this README supplies no
funded-wallet enrollment or secret-export recipe. Do not inspect funded secret
files to make a skipped scenario pass.

Demo capture lives in its own lane, `demo/capture-demo.mjs`, outside this suite.
It records an unpacked release artifact with a disposable demo wallet: import and
unlock happen before any capture, Settings' root is never recorded, and a guard
(`demo/guard.mjs`, tested by `node --test demo/guard.test.mjs`) refuses any frame
showing a password, phrase, recovery, export or nsec surface. Output stays in
`~/Build/smirk-marketing`; nothing is promoted automatically. Re-enabling
full-suite capture or cropping a completed recording is still not admitted.

The capture regression deliberately fails a browser assertion with a generated
sentinel in the input and page. It checks output and files without printing that
value, then removes its temporary files:

```sh
npm run test:privacy -w @smirk/e2e
```

This regression also exercises the installed Playwright failure-artifact behavior.
Keep it when upgrading Playwright; screenshot settings alone are insufficient.

## Configuration and coverage

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKEND_URL` | `http://127.0.0.1:8080/api/v1` | Runtime test target, including API mount. |
| `VITE_SMIRK_BACKEND_URL` | Same local URL | Backend compiled into the extension build. |
| `VITE_SMIRK_API_STYLE` | `namespaced` | Dialect used by `smirk-backend-core`. |
| `EXTENSION_DIST` | `packages/extension/dist` | Built extension to load. |
| `HEADED` | Unset | Set to `1` for a visible local browser. |
| `E2E_MIN_EXECUTED` | `21` | Execution floor enforced by the skip guard. |

Run the broader suite through `npm run e2e -w @smirk/e2e` after its reviewed
backend and wallet prerequisites are available. The skip guard fails unexpected
skips and runs below the execution floor. Capability-dependent scenarios prove
only the configuration exercised. Their exceptions are owned by
`skip-guard-reporter.ts`; a skip is never a pass. Reporter overrides are refused.

| Scenario group | Evidence |
| --- | --- |
| Cold launch and onboarding | Initial surface, popup-to-tab creation and pre-interaction network behavior. |
| Fundless release review | Real registration, Send navigation, confirmation settings, grace restore and cross-window Lock. |
| Import, restore and migration | Returning-wallet and historical scan behavior, with separately supplied test-wallet prerequisites. |
| Receive, send composition and swaps | Client derivation, navigation and reviewed fixtures; quote stubs do not prove provider uptime. |
| Identity, messaging and federation | Real configured backend/relay behavior when the required services exist. |
| Live spend | Separate explicitly reviewed financial lane; not part of a fundless pass. |

Do not infer authentication from an offscreen `waitForResponse`: extension
background traffic is not necessarily visible to page listeners. Use the
scenario's actual application or backend evidence. A rendered zero balance alone
does not prove authentication or scan completeness.

## Release evidence checklist

- [ ] Record the exact client/backend source, build and scenario selection.
- [ ] Keep secrets out of command arguments, logs, failure output and artifacts.
- [ ] Confirm the expected tests executed and disclose skips or missing services.
- [ ] Separate fundless browser evidence from live-chain, desktop and store checks.
- [ ] Record private operational evidence under `~/journal`.
