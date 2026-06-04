# Changelog

All notable user-facing changes to Smirk Wallet.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This monorepo packages the Smirk Wallet browser extension (Chrome MV3
+ Firefox), the upcoming Tauri desktop shell, and the shared core /
UI / asset / swap libraries that power both. Version numbers refer to
the public wallet build.

Backend changes that don't affect wallet behaviour land separately in
the private `smirk-backend` repo and aren't echoed here.

## [Unreleased]

Pre-release polish for v0.3.0. Reproducible-build dry run, Tauri
desktop shell, and store submission artefacts still pending. See
`docs/V0_3_PLAN.md` rev 9 (internal) for the running ship plan.

## [0.3.0] — 2026-06-04

First v0.3 release candidate. Ground-up rewrite of the wallet
extension around a shared monorepo (`packages/core`, `packages/ui`,
`packages/assets`, `packages/swap`, `packages/dapp-api`) so the
Tauri desktop build and Capacitor mobile shell can share the same
code path as the extension. The legacy `smirk-extension` v0.2.x
codebase (currently in the Chrome Web Store + AMO) stays operational
through v0.3.0 release — existing users can upgrade in place using
their 12-word seed.

### Added

- **Trocador swap surface** — in-wallet crypto swaps via Trocador's
  CEX aggregator. Non-custodial: the wallet talks directly to
  `api.trocador.app` with an affiliate key bundled in the build, so
  Smirk never holds your funds and the deposit address comes from
  the provider, not us. Top-level Swap tab; quote → deposit →
  status wizard; full BTC / LTC / XMR routing. WOW and GRIN are
  off-route at Trocador today and surface a clear "no route" state.
- **Asset-detail screen** — tap any asset on Home for a per-coin
  drill-down with a 2-week sparkline, Send / Receive / Tip
  shortcuts, and a unified Activity feed.
- **Tipping receive surface** — Inbox tab lists claimable social
  tips with per-tip Claim affordance. New "+ Paste tip link" entry
  point lets you claim from a `smirk.cash/tip/...#...` URL pasted
  directly into the wallet. Home shows a banner when one or more
  tips are ready to claim.
- **Public-tip share affordance** — when you send a public tip,
  the share URL is hidden on the success screen until funding has
  confirmed enough to be claimable. Home shows a "🔗 N public tips
  ready to share" banner as soon as the URL is safe to distribute;
  tapping routes to Settings → Sent Tips with a Copy-link button.
- **dapp adapter** — `window.smirk` API for sites that want to
  let users sign in, sign messages, request payments, or claim
  tips with their Smirk wallet. End-to-end wired this release; see
  `packages/dapp-api/README.md` for the protocol.
- **Sent Tips screen** (Settings → Sent Tips) — cross-asset list
  of every tip you've sent with inline Clawback for unclaimed tips
  and Discard for drafts. Locally-backed-up tips render a 🔐
  badge so you know recovery is available even if the backend
  loses the row.
- **`window.smirk` injection toggle** in Settings — opt out of
  per-site detection of "Smirk is installed" if you don't want
  websites to know you're using the wallet. Breaks dapp
  integrations on that browser profile.
- **Per-asset hidden-assets** in Settings. Hidden assets stop
  polling the backend until you re-enable them; the wallet still
  owns the keys. Auto-unhides on tip claim so swept funds don't
  vanish.
- **DMG / N64 / Win95 / WinXP / Amiga / iOS Classic themes**
  alongside the default dark. Settings → Theme.
- **Activity feed for in-flight outgoing transactions** — sends,
  tip-funding broadcasts, and swap deposits all appear as a
  "pending" row at the top of the per-asset Activity feed until
  the chain catches up. Swap-deposit rows tap back to the swap
  status page.
- **Asset balance display caps** — Home shows BTC at 8 decimals,
  LTC and XMR at 4, WOW and GRIN at 2 to keep the row tight.
  AssetDetail hover and copy still show full precision.

### Fixed

- **Clawback now actually returns funds** *(CRITICAL)*. Prior to
  this release, hitting Clawback marked the tip as "clawed back"
  on the backend but did nothing on-chain — the funds stayed at
  the tip address. We now decrypt your locally-stored tip key,
  sweep the tip address back into your wallet on-chain, and only
  then mark the backend. Affects all 5 chains (BTC, LTC, XMR,
  WOW, Grin). If you clawed back a tip on an earlier v0.3 build
  and the funds didn't arrive in your wallet, the on-chain
  recovery flow can still rescue them — contact support with the
  tip id.
- **Tip claim retry hardening** — `confirm tip sweep` and
  `attach funding` calls now retry 3× with exponential backoff
  (1s / 3s / 9s) so a transient network glitch on either side of
  a broadcast doesn't leave your wallet's view out of sync with
  the chain.
- **Cross-chain dapp claim no longer fails on first try** —
  claiming a public Grin/XMR/WOW tip via `smirk.cash` used to
  throw a WASM init error on first dispatch. Now ensures the
  cryptography module is loaded before any approval handler runs.
- **Smirk wallet no longer shows "Waiting for your deposit" after
  swap completes** — if the provider's status webhook to our
  backend drops on the floor, the wallet now polls the provider
  directly as a backstop.
- **Sent-tip share link respects funding confirmations** — the
  Tip Sent screen for XMR/WOW/GRIN public tips now waits to show
  the share URL until enough confirmations have buried the
  funding tx. Prevents accidentally sharing a link the recipient
  can't yet claim.
- **Home balance loads incrementally** — Bitcoin / Litecoin /
  Grin balances now appear as each chain responds rather than
  blocking on the slowest (typically Monero LWS catching up).
  Snapshot cache means the headline number renders instantly on
  popup reopen.
- **Settings tab no longer doubles** under the DMG theme on some
  Brave builds. Root cause was a `BigInt`-mixing throw in the
  balance snapshot's serializer that broke Preact reconciliation
  mid-render.
- **GRIN voucher recovery flow** validated end-to-end via a live
  orphan-tip recovery this session.

### Backend (announced for transparency)

The private backend received seven hardening passes alongside the
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
  matched the UPDATE — defensive against future DB inconsistency.
- Grin balance query filters out orphan unconfirmed outputs
  whose parent transaction never confirmed (a pre-v0.3 client
  pre-record artefact).

### Compatibility

- **Browser extension v0.2.x in-place upgrade** — installing the
  v0.3.0 build on top of an existing v0.2.x install keeps your
  wallet intact. Your 12-word seed continues to derive the same
  addresses; balances, sent-tips history, and your linked social
  accounts all come back. **Back up your seed before upgrading**
  if you don't already have a paper copy.
- **Backend v0.3 endpoints are additive over v0.2.x** — v0.2.x
  clients continue to work against the new backend during the
  upgrade rollout. There is no flag-day cutover.
- **Pre-v0.3 BIP44 key derivation** continues to work for users
  who imported their wallet in 2026-04 or later (BIP84 since
  commit 84773c0). If you imported earlier and see a public-key
  mismatch on upgrade, check `docs/MIGRATION.md` (backend, internal)
  for the audit context.

### Known issues

- The Tauri desktop shell is not yet shipped — extension is the
  only first-class surface in 0.3.0. Capacitor mobile is also
  deferred to a v0.3.x point release.
- Onboarding does not yet split between Quick (defaults) and
  Advanced (per-asset RPC override) flows; private-LWS mode
  toggle deferred to v0.3.x.
- Public-tip claims via the Inbox row (as opposed to URL paste)
  fail for tips that the dapp adapter previously attempted —
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
in-wallet migration UI — see `docs/MIGRATION.md` in the backend
repo for the small-population recovery path.

Privacy posture is unchanged: optional LWS for XMR/WOW (Smirk-
operated default; private-LWS toggle landing in v0.3.x),
Smirk-published Electrum proxy for BTC/LTC, Smirk-operated Grin
node. Trocador swaps are off by default — only activated when
you tap into the Swap tab.

[Unreleased]: https://github.com/SuchSoftware/smirk-monorepo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/SuchSoftware/smirk-monorepo/releases/tag/v0.3.0
