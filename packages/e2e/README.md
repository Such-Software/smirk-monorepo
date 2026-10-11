# Wallet browser integration tests

> Status: active · Updated 2026-10-10 · Applies to: Smirk client source

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

## Run the v0.3.1 release run (every live area, recorded)

`npm run test:live-v031 -w @smirk/e2e` runs every live area against the staged
release candidate (run 11204: the Chrome zip for Chromium, the Firefox zip for
Firefox) and production, one lane at a time, in the order of the release
survey. It spends real funds among the demo wallets alice, bob and carol.
`scripts/live-v031.mjs` holds the order, every gate and every path; `--list`
prints the plan without touching anything.

| Step | Phase | Lane config | What it proves |
| --- | --- | --- | --- |
| 0 | preflight | (runner) | Zip hashes, unpack, capabilities and prices, every offline guard, privacy, disk, custody, decisions. |
| 1 | baseline | `B-send-receive-history.live.config.ts` | Every balance held 25 s and the funding check, before money moves. |
| 2 | A | `playwright.live.config.ts` | Onboarding, lock policy, website sign-in, identity. |
| 3a, 4b, 7, 8 | E | `E-swaps.live.config.ts` | THORChain both ways for real, quotes, Trocador, NonLogs, Where to trade. |
| 3b, 6, 9, 10 | B | `B-send-receive-history.live.config.ts` | Three hops per coin and every history sheet. |
| 4b | D | `D-messaging-federation.live.config.ts` | Messaging, background delivery, burners, outside Nostr, backend B. |
| 3c to 5 | C | `C-tips.live.config.ts` | Link, npub, name and federated tips, forged wraps, claims, clawbacks. |
| 4b, 11 | G | `G-premium.live.config.ts` | Plan labels, invoices, checking; the purchase when approved. |
| 4b, 12 | F | `F-legacy-recovery.live.config.ts` | Older addresses, old-server claims; seeded moves when approved. |
| 13 | H-firefox, H-macos | `tests/live/h-firefox.live.mjs`, `scripts/desktop-smoke-macos.sh` | Firefox, Firefox with RFP prefs, Chromium; the macOS app (on the Mac). |
| 14 | closeout | `B-send-receive-history.live.config.ts` | Every final balance held 25 s, for reconciliation. |

Each lane stays whole (its own ledger, rescue and teardown), so the survey's
interleaving becomes this order. The run refuses, naming the cause, unless
`E2E_LIVE=1`, `E2E_LIVE_MONEY=1`, `ALLOW_PROD_WRITES=1`, `E2E_LIVE_RELAY=1`,
`FOOTAGE=guarded` and `E2E_WALLET_FILE` (the custody file's path) are set and
the owner has answered yes or no to each decision: `V031_IDENTITY_WRITES`,
`V031_FEDERATION_B`, `V031_NONLOGS_SWAP`, `V031_PREMIUM_PURCHASE`,
`V031_LEGACY_FIXTURE` and `V031_FEED_POST`. None has a default. The macOS
smoke runs only on the Mac: elsewhere pass `--except H-macos`, then run
`--only H-macos` there.

Footage, video, ledgers and evidence go to `~/Build/smirk-e2e/v031-run/<UTC
date>/`, one directory per area, with `run.json`, per-phase attempt records,
logs and `summary.json`. Each lane's encoder runs after its phase and refuses a
hold shorter than the owner's policy. A failed phase stops the run; `--resume`
continues it and never repeats a phase that passed. Reconciling the final
balances against the baseline, the fees, the swap spread and the premium
payment, and the evidence note in `~/journal`, remain step 14 by hand.

Every lane's offline guards (recorders on sentinel pages, hold policies,
encoders, ledgers, spec lints and this runner) run with no wallet or funds,
and so does a check that no lane's recorder holds less than the owner's video
policy (6 s before a tap, 12 s settled, 25 s on a key result):

```sh
npm run test:live-v031-guards -w @smirk/e2e
```

## Secret output policy

Playwright capture is closed for the wallet suite and every lane, including
failed tests. The only footage comes from the separately guarded recorders
described below (demo capture, and the guarded recorder of each live lane,
areas A to H):

- Trace, screenshots and video are off. CLI and per-test capture overrides refuse.
- Accessibility snapshots are suppressed, and error values/call logs are sanitized
  before failure artifacts are built. A generated phrase can appear in a DOM
  snapshot even when the screenshot setting is off.
- The private reporter prints source locations and outcomes. It does not forward
  browser stdout, assertion values, attachments, steps or HTML reports.
- Each failure is explained, by shape only, in a private log (JSON lines, 0600
  in a 0700 directory): the error class (its class name, the Playwright call or
  matcher, a fixed category such as action timeout, and the file and line of
  the `at` frame that threw), the lane step label that was running, the test ids
  on every wallet screen with id-like parts replaced by `*`, and recent requests
  as method, host, route words and status. Never a message, page text, input
  value, query, header or body. A step label or test title is kept only when
  every token has an allowed shape (plain words, acronyms, short numbers) and it
  holds no run of six recovery-phrase words; otherwise it is withheld whole.
  Footage helpers check a label before they note it as the running step. `E2E_PRIVATE_LOG` names the file (the v0.3.1 runner puts it
  beside each phase log); otherwise it goes under `~/Build/smirk-e2e/private-logs`.
  `fixtures/failure-record.mjs` defines the shapes, and the reporter re-shapes
  everything a worker hands it before writing.
- Playwright traces stay off even with screenshots and snapshots off: a trace
  still records what `fill` typed, what `textContent` read and the console, and
  its network log exists only with snapshots on, where it keeps request headers.
  `scripts/test-private-capture.mjs` proves both against the installed version.
- A lane that reopens a kept wallet profile brings it back to Home's root from
  whatever screen it restored (`fixtures/wallet-recovery.ts`): a result's own
  close control, Back through a Send draft that holds no funds in flight, a
  coin screen's Back, then the Home tab, within a minute. It never cancels a
  swap or a Grin exchange, never answers a password prompt, and logs where it
  started and the moves it made.
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

### E-swaps live lane capture (pending owner review)

`E-swaps.live.config.ts` runs `tests/live/e-swaps.live.spec.ts` against a real
backend with the demo wallets alice, bob and carol, and can record the run for
the owner's release review (`FOOTAGE=guarded`). Its gates, paths and outputs
are listed in `fixtures/E-swaps-live.ts`. It differs from demo capture in one
reviewed way, and that difference needs the owner's explicit approval before
its footage is treated as admitted release evidence:

- **Mask and continue, not refuse.** A long live run meets the lock screen,
  the operation password prompt and the NonLogs private status link during
  ordinary swaps, so a guard that refuses the whole run on any such surface
  cannot record one. `fixtures/E-swaps-guard.mjs` classifies every frame
  instead: clean; masked (password fields, tx key, tip share URL, pasted tips,
  nsec surfaces are covered by screenshot masks, and the frame is kept only if
  two guard passes agree); or a redaction card (recovery phrase screens,
  private key text, tip claim links: no screenshot is taken at all). A canary
  holds only hashes of each phrase's three-word runs, the run's random wallet
  password and any registered bearer link, and turns a frame showing one into
  a card.
- **Same start as demo capture.** A wallet's recorder starts on Home, after
  the import and unlock and two clean guard passes; the import is a card in
  the timeline and is never captured. A reopened popup records from its lock
  screen with the password field masked. Typing a password happens only
  inside a secret scope, with the recorder paused and frames already in
  flight dropped.
- **Dead air by rule.** `fixtures/E-swaps-policy.mjs` holds the owner's video
  policy: 6 s still before every tap or typed field, 12 s settled on every
  screen an action leads to, 25 s on key results. The recorder applies it to
  every action, and `scripts/E-swaps-encode.mjs` refuses a timeline with a
  short hold or with a screen that was never held. The one reviewed exception
  is Send's done screen, which closes itself after 12 s: "Stay on this screen"
  is tapped after its 6 s hold and the kept screen is then held 25 s.
- **One run, one proved build.** A recorded run (and any test that spends)
  requires `EXTENSION_ZIP`; every file of that release zip must match the
  unpacked build byte for byte. The run's directory holds its evidence (the
  zip's SHA-256, the test source commit, public results) and its timelines,
  and the encoder reads only the run it is told to (`--run <id>` or
  `--latest`), never an earlier one.

Footage and evidence stay under `~/Build/smirk-e2e` (0700 directories, 0600
files); nothing is uploaded or promoted. The lane's guards run in CI with no
backend or wallet:

```sh
npm run test:e-swaps-guards -w @smirk/e2e
```

Real swaps are entered in an in-flight ledger (`fixtures/E-swaps-ledger.mjs`,
`~/Build/smirk-e2e/E-swaps-inflight.json`) just before their Send tap and leave
it only when the provider finishes them. While an entry is open no run starts
that swap again; clear one with `E_SWAPS_CLEAR_INFLIGHT=<provider:from-to>`
only after checking the swap at the provider.

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

## C-tips live lane

`C-tips.live.config.ts` runs `tests/live/c-targeted-tips` and `c-tips` against a
real backend with the alice, bob and carol demo wallets: link tips, person tips by
npub, `@name`, `name` and `name@domain`, federated tips (a foreign NIP-05 domain
and a second backend), forged gift wraps, a blocked delivery, claims, clawbacks
and settlement on BTC, LTC, XMR, WOW and GRIN. The main config ignores
`tests/live`. Every gate is closed by default and the global setup prints why it
refused. The command and every variable are in the config's header.

- **Release binding.** The setup checks the candidate zip's SHA-256 and manifest
  version, unpacks it into the run's state directory and loads only that.
- **Funds safety.** Each tip enters `C-tips-state/ledger.json` as soon as the
  backend names it (ids only, never a link). Tests are independent, a restarted
  worker reopens the same browser profiles, and each file ends with a rescue that
  reclaims any tip still holding funds. The teardown deletes the profiles only
  when every tip is claimed or clawed back; otherwise it keeps them and writes
  `RECOVERY.md` with the rescue command.
- **Skips.** Only an optional rehearsal, an acknowledged gap
  (`E2E_LIVE_ACK_GAPS=federation`) or a rescue run may skip. Any other skip, such
  as a demo wallet that needs a top-up, fails the run with its reason.
- **Video.** `FOOTAGE=guarded` is required, so the run cannot finish unrecorded.
  Each hold must keep the recorded frame unchanged for 6 s before a tap, 12 s on a
  settled screen and 25 s on a key result. A changing screen restarts the hold.
  The teardown runs `scripts/C-tips-encode.mjs`, which writes per-wallet and
  side-by-side MP4s in real time and checks every hold against the encoded
  frames. Do not run `process-footage.mjs` on this footage: it trims dead air.
- **Capture policy.** The recorder is a new capture lane over live wallet
  sessions. Recovery phrases, password fields and protected screens become
  cards. Claim links and key material are masked, and a frame whose mask target
  changed during capture is dropped. This still conflicts with the
  no-capture-lane statement in `capture-policy.mjs` and `fixtures/footage.ts`.
  The owner must sign off before its output is used.

Offline checks (no wallet, no funds):

```sh
node --import tsx --test fixtures/C-tips-guard.test.mjs fixtures/C-tips-encode.test.mjs \
  fixtures/C-tips-forge.test.mjs fixtures/C-tips-lane.test.mjs
```

## Release evidence checklist

- [ ] Record the exact client/backend source, build and scenario selection.
- [ ] Keep secrets out of command arguments, logs, failure output and artifacts.
- [ ] Confirm the expected tests executed and disclose skips or missing services.
- [ ] Separate fundless browser evidence from live-chain, desktop and store checks.
- [ ] Record private operational evidence under `~/journal`.
