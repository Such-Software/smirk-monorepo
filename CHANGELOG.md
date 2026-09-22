# Changelog

All notable user-facing changes to Smirk Wallet.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This monorepo packages the Smirk Wallet browser extension (Chrome MV3
+ Firefox), the Tauri desktop shell, and the shared core /
UI / asset / swap libraries that power both. Version numbers refer to
the public wallet build.

Backend changes that don't affect wallet behaviour land separately in
the public `smirk-backend-core` repo and aren't echoed here.

## [0.3.0] - 2026-09-21

Adds a desktop wallet, Nostr identity and messaging, and a self-hostable
backend, alongside broad reliability work across all five chains.

### Added

- **Desktop wallet.** A Tauri 2.x shell for Windows, macOS and Linux, sharing
  the extension's code and carrying the embedded dapp browser. Mobile is
  deferred to v0.4.
- **Nostr identity.** A NIP-07 `window.nostr` provider, so Nostr-native sites
  can request your key and have events signed without a second extension.
  Identities live in a switchable vault, with a per-origin picker and a header
  switcher; payment-capable actions sit behind a short-lived session so a
  signing grant cannot move funds. Identities can be backed up and restored as
  an encrypted blob.
- **NIP-05 handles.** Claiming a Smirk handle can publish a `name@domain`
  record, and links your primary identity automatically.
- **Messaging.** Encrypted direct messages share the Inbox with tips. Grin
  payments can travel as NIP-59 gift-wrapped messages, so a slatepack exchange
  needs no shared server.
- **Federation.** The backend host is configurable; nothing assumes
  `api.smirk.cash`. You can pay a NIP-05 address, with the counterparty's key
  pinned on first use so a later swap is flagged rather than trusted.
- **Self-hostable components.** A standalone Grin light-wallet-server
  (`grin-lws`, MIT) and a non-custodial BTC/LTC invoicing service, so an
  operator can run the full stack without the main backend.
- **Wallet controls.** A lock button, and the option to open the wallet in a
  browser tab as well as its own window.

### Changed

- **Grin is fully non-custodial.** The backend holds no Grin balances, outputs
  or transaction records, and the custodial endpoints and server-side wallets
  table are gone. The wallet derives a view-only rewind credential from your
  seed; scanning runs against a `grin-lws` instance that can read your outputs
  but cannot spend them, and in-flight sends are tracked client-side. See
  `docs/grin.md`.
- **Grin wallets restore from the seed phrase alone.** Outputs use the standard
  deterministic rewind-nonce scheme, so a restored wallet rediscovers them from
  the chain rather than from server records, matching how the other chains
  already restore. Outputs from earlier builds remain spendable.
- **Tips are encrypted to a key of the sending coin.** Each asset uses its own
  encryption target rather than a shared Bitcoin key, so a recipient who does
  not use Bitcoin is no longer sent funds locked behind one.
- **Balances load instantly.** Home paints the last known balance immediately,
  refreshes in the background and on refocus, and shows a freshness indicator
  when updates stall or the server is unreachable.
- **Dapp payments take decimal amounts.** A site passes `"9"` or `"9.5"`; the
  wallet converts using the asset's decimals. A malformed amount is refused
  with a clear error.
- **Store listings and the privacy policy describe what actually happens**, and
  the stated retention windows are enforced rather than configured.

### Fixed

- **Transaction history is correct on every chain.** Monero and Wownero listed
  transactions that were not yours: the light-wallet server reports candidate
  spends, which include your outputs appearing as decoys in other people's
  transactions, and these were shown as your own sends. They are now verified
  against your spend key. A send with change is reported as a send rather than
  as an incoming transfer of its change. Bitcoin and Litecoin show real amounts
  instead of zero, are no longer listed once per address, and read newest-first.
  Grin history is per-wallet rather than per-device.
- **Send opens on the coin you selected**, and no longer replays the previous
  transaction's receipt. The receipt returns home on its own.
- **Monero and Wownero sends no longer fail intermittently.** Rings could be
  built with a repeated member, which the signer rejects.
- **Taproot addresses are accepted** for sending, swapping and refunds.
- **Websites can talk to the wallet.** The dapp bridge reported the wallet as
  locked shortly after a connection was approved.
- **Firefox can create and restore a wallet.**
- **Signing in returns you to your account** instead of creating a second,
  empty one after a keep-unlocked session.
- **Your Nostr identity stops broadcasting when you stop using it**, including
  after locking, switching backend and forgetting a wallet.
- **Burner identities never fall back to your main identity** silently.
- **The fee you see is the fee you sign.** A rate below the relay minimum was
  displayed as typed and raised at broadcast.
- **Cross-chain sends are blocked.** A Monero address could be used as a
  Wownero destination, and the reverse.
- **Malformed Grin slates are rejected** rather than crashing or desynchronising
  the parser.
- **Connected sites are visible and revocable**, and a site cannot spam
  approval windows.
- **Chat and Nostr work after a keep-unlocked session.**
- **Public tip keys are encrypted at rest.**

## [0.3.0-rc1] - 2026-06-04

First v0.3 release candidate. Ground-up rewrite of the wallet
extension around a shared monorepo (`packages/core`, `packages/ui`,
`packages/assets`, `packages/swap`, `packages/dapp-api`) so the
Tauri desktop build and Capacitor mobile shell can share the same
code path as the extension. The legacy `smirk-extension` v0.2.x
codebase (currently in the Chrome Web Store + AMO) stays operational
through v0.3.0 release, existing users can upgrade in place using
their 12-word seed.

### Added

- **Desktop wallet with embedded dapp browser**: Tauri 2.x build
  for macOS, Windows, and Linux that runs the same Preact wallet
  UI as the extension via a `chrome.*` shim. New "Browse" tab opens
  an in-app browser with per-tab `window.smirk` injection so dapps
  that integrate with Smirk work without leaving the wallet. Each
  browser tab is its own borderless `WebviewWindow` positioned over
  the wallet UI's frame slot and locked to wallet movement via a
  window-event hook. Capability scope on embedded webviews is
  intentionally narrow, `event:emit`/`listen`/`unlisten` only, so
  a malicious page can't reach plugin-store, plugin-shell, or any
  other Tauri surface. See `docs/EMBEDDED_BROWSER.md` for the
  architecture write-up including the `add_child` → `WebviewWindow`
  pivot motivated by a Linux/WebKitGTK layout quirk.
- **Trocador swap surface**: in-wallet crypto swaps via Trocador's
  CEX aggregator. Non-custodial: the wallet talks directly to
  `api.trocador.app` with an affiliate key bundled in the build, so
  Smirk never holds your funds and the deposit address comes from
  the provider, not us. Top-level Swap tab; quote → deposit →
  status wizard; full BTC / LTC / XMR routing. WOW and GRIN are
  off-route at Trocador today and surface a clear "no route" state.
- **Asset-detail screen**: tap any asset on Home for a per-coin
  drill-down with a 2-week sparkline, Send / Receive / Tip
  shortcuts, and a unified Activity feed.
- **Tipping receive surface**: Inbox tab lists claimable social
  tips with per-tip Claim affordance. New "+ Paste tip link" entry
  point lets you claim from a `smirk.cash/tip/...#...` URL pasted
  directly into the wallet. Home shows a banner when one or more
  tips are ready to claim.
- **Public-tip share affordance**: when you send a public tip,
  the share URL is hidden on the success screen until funding has
  confirmed enough to be claimable. Home shows a "🔗 N public tips
  ready to share" banner as soon as the URL is safe to distribute;
  tapping routes to Settings → Sent Tips with a Copy-link button.
- **dapp adapter**: `window.smirk` API for sites that want to
  let users sign in, sign messages, request payments, or claim
  tips with their Smirk wallet. End-to-end wired this release; see
  `packages/dapp-api/README.md` for the protocol.
- **Sent Tips screen** (Settings → Sent Tips), cross-asset list
  of every tip you've sent with inline Clawback for unclaimed tips
  and Discard for drafts. Locally-backed-up tips render a 🔐
  badge so you know recovery is available even if the backend
  loses the row.
- **`window.smirk` injection toggle** in Settings, opt out of
  per-site detection of "Smirk is installed" if you don't want
  websites to know you're using the wallet. Breaks dapp
  integrations on that browser profile.
- **Per-asset hidden-assets** in Settings. Hidden assets stop
  polling the backend until you re-enable them; the wallet still
  owns the keys. Auto-unhides on tip claim so swept funds don't
  vanish.
- **DMG / N64 / Win95 / WinXP / Amiga / iOS Classic themes**
  alongside the default dark. Settings → Theme.
- **Activity feed for in-flight outgoing transactions**: sends,
  tip-funding broadcasts, and swap deposits all appear as a
  "pending" row at the top of the per-asset Activity feed until
  the chain catches up. Swap-deposit rows tap back to the swap
  status page.
- **Asset balance display caps**: Home shows BTC at 8 decimals,
  LTC and XMR at 4, WOW and GRIN at 2 to keep the row tight.
  AssetDetail hover and copy still show full precision.

### Pre-release hardening

v0.3.0 is the first v0.3 release, so these aren't regressions
from a shipped build, they're issues found during the release-
candidate dogfood cycle and squashed before any binary went out
publicly. Called out individually because the security-conscious
audience that reads CHANGELOGs cares.

- **Clawback now performs an on-chain sweep** *(CRITICAL during
  RC; never shipped publicly)*. Earlier dogfood builds of
  v0.3.0's Clawback button marked the tip as "clawed back" on
  the backend but did nothing on-chain, funds would have stayed
  at the tip address. Now the wallet decrypts your locally-stored
  tip key, sweeps the tip address back into your wallet on-chain,
  and only then notifies the backend. Applies to all 5 chains
  (BTC, LTC, XMR, WOW, Grin). v0.2.x in the public stores already
  has the correct flow; this only affected internal RC builds.
- **Tip claim retry hardening**: `confirm tip sweep` and
  `attach funding` round-trips now retry 3× with exponential
  backoff (1s / 3s / 9s) so a transient network glitch on either
  side of a broadcast doesn't leave your wallet's view out of
  sync with the chain.
- **Cross-chain dapp claim WASM init**: the approval popup
  (the standalone window that opens when a website calls
  `window.smirk.claimPublicTip(...)`) now ensures the
  cryptography WASM module is loaded before dispatching. Pure-JS
  paths (BTC / LTC payments) were already fine; Grin / XMR / WOW
  claims via the dapp adapter now work on first dispatch.
- **Trocador status backstop**: if the swap provider's status
  webhook doesn't reach our backend, the wallet polls the
  provider directly. Status field reflects on-chain reality even
  when our infrastructure misses an update.
- **Tip Sent share link gated on funding confirmations**: for
  confirmation-gated chains (XMR / WOW / GRIN), the share URL is
  hidden on the Tip Sent screen until funding has buried enough
  to be claimable. Home shows a banner the moment it's safe to
  share, replacing the previous "we trust you to time this
  yourself" model.
- **Home balance loads incrementally**: BTC / LTC / Grin
  balances now appear as each chain responds rather than blocking
  on the slowest (typically Monero LWS catching up). Snapshot
  cache surfaces the last-known headline number instantly on
  popup reopen.
- **JSON-safe balance snapshot**: explicit `BigInt → string`
  serialization at the storage boundary side-steps a Brave-
  specific structured-clone behaviour that could throw "Cannot
  mix BigInt and other types" on a subsequent balance read.
- **GRIN voucher recovery validated end-to-end** during the RC
  cycle, restoring a lost-then-recovered orphan tip via the
  URL-paste public-claim path landed funds in the recipient
  wallet as expected.

### Backend (announced for transparency)

The `smirk-backend-core` backend received seven hardening passes alongside the
wallet work. None of them changes the wire format you interact
with, but for the security-conscious:

- Trocador-status backup poller (so missed provider webhooks
  don't strand swaps on the backend's view).
- Tip-draft GC: abandoned `draft` tips get garbage-collected
  after 24 hours so LWS view-key registrations don't leak
  forever.
- Webhook token comparison now constant-time *and* padded
  against the length oracle (`subtle::ConstantTimeEq` was already
  there; this hardens the dispatch path around it).
- Confirmation-checker SQL has a regression test guarding the
  `pending` vs `pending_confirmation` status filter.
- Clawback race-fix: backend now accepts clawback from the
  `claiming` state too (was strictly `pending`) so a concurrent
  claim attempt by a recipient doesn't make the sender's
  Clawback button fail spuriously after the on-chain sweep
  already succeeded.
- Grin slatepack broadcast emits a log when no slatepack row
  matched the UPDATE, defensive against future DB inconsistency.
- Grin balance query filters out orphan unconfirmed outputs
  whose parent transaction never confirmed (a pre-v0.3 client
  pre-record artefact).

### Compatibility

- **Browser extension v0.2.x in-place upgrade**: installing the
  v0.3.0 build on top of an existing v0.2.x install keeps your
  wallet intact. Your 12-word seed continues to derive the same
  addresses; balances, sent-tips history, and your linked social
  accounts all come back. **Back up your seed before upgrading**
  if you don't already have a paper copy.
- **Backend v0.3 endpoints are additive over v0.2.x**: v0.2.x
  clients continue to work against the new backend during the
  upgrade rollout. There is no flag-day cutover.
- **Pre-v0.3 BIP44 key derivation** continues to work for users
  who imported their wallet in 2026-04 or later, when derivation
  moved to BIP84. If you imported earlier and see a public-key
  mismatch on upgrade, check `docs/MIGRATION.md` (backend, internal)
  for the audit context.

### Known issues

- The Tauri desktop shell is not yet shipped, extension is the
  only first-class surface in 0.3.0. Capacitor mobile is also
  deferred to a v0.3.x point release.
- Onboarding does not yet split between Quick (defaults) and
  Advanced (per-asset RPC override) flows; private-LWS mode
  toggle deferred to v0.3.x.
- Public-tip claims via the Inbox row (as opposed to URL paste)
  fail for tips that the dapp adapter previously attempted,
  the Inbox path doesn't have access to the URL fragment.
  Workaround: re-paste the tip URL via "+ Paste tip link"
  instead. Stale rows older than 2 minutes are hidden so this
  surface stays actionable for new claims.

### Migrating from v0.2.x

Most users won't need to do anything special. The extension auto-
upgrades the wallet's PBKDF2 KDF iterations from 100k → 600k on
first unlock; this happens silently. Your seed, addresses, and
linked socials carry over.

If you were on an early-2026 alpha (XMR/WOW v1 or v2 derivation),
you've likely already migrated via the legacy
`/auth/migrate-keys` flow in v0.2.x. v0.3 does not include the
in-wallet migration UI, see `docs/MIGRATION.md` in the backend
repo for the small-population recovery path.

Privacy posture is unchanged: optional LWS for XMR/WOW (Smirk-
operated default; private-LWS toggle landing in v0.3.x),
Smirk-published Electrum proxy for BTC/LTC, Smirk-operated Grin
node. Trocador swaps are off by default, only activated when
you tap into the Swap tab.

[Unreleased]: https://github.com/Such-Software/smirk-monorepo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Such-Software/smirk-monorepo/releases/tag/v0.3.0
