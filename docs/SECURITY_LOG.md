# Security Log

Chronological record of cryptography- or privacy-relevant fixes in the
monorepo. New entries on top.

---

## 2026-06-13 — Auto-unlock cache: keystore.ts header lied about plaintext mnemonic

**Severity:** Documentation defect (no runtime change)
**Reporter:** internal review of
[`packages/core/src/keystore.ts`](../packages/core/src/keystore.ts)
**Status:** Header comment fixed in this commit. Runtime
re-architecture tracked for v0.3.x (see "Planned fix" below).

### What was wrong

The `keystore.ts` file-level JSDoc (lines 13-22 of the pre-fix file)
claimed:

> Seed and derived keys **never** persist plaintext to any
> `chrome.storage` backend. […] We do **not** stash an ephemeral
> session unwrap key in `storage.session` (the legacy pattern that
> lets SW restart auto-unlock — and produces a plaintext-seed-
> equivalent at rest).

That description was accurate for the original v0.3.0 design but
became stale when the "auto-lock after N minutes" UX shipped. The
actual runtime behaviour, implemented by `rebuildUnlockedFromMnemonic`
and the `SESSION_CACHE_KEY` constant in the same file, is:

- When the user picks `autoLockMinutes > 0` (any non-zero value
  including the `Number.MAX_SAFE_INTEGER` "Never" sentinel), the
  popup writes a `SessionCacheEntry { mnemonic, fingerprint,
  expiresAtMs }` into `chrome.storage.session` so subsequent popup
  reopens skip the password prompt.
- The mnemonic is stored **as a plaintext string** in that cache
  — no wrapping, no encryption-at-rest within `storage.session`.

The header comment described an in-principle threat model that no
longer matched what the code did. A reader trusting the comment
would mis-state the wallet's exposure window during a security
review or external audit.

### Why the runtime behaviour is still acceptable (for now)

`chrome.storage.session` is **not** equivalent to `storage.local`:

- It is held in browser process memory only — Chrome never writes
  it to disk. Browser close (not just window close) clears it.
- It is partitioned per extension ID. A co-resident malicious
  extension cannot read another extension's `storage.session`,
  the same isolation that protects `storage.local`.
- The exposure window is bounded by `autoLockMinutes` — the popup's
  unlock-state check evicts the entry when `Date.now() >
  expiresAtMs`.

The remaining exposure is **process-memory disclosure** — an
attached debugger, OS-level malware with the right privileges, or
a mid-flight heap snapshot can read the cached mnemonic. That is
the same exposure level as the popup's own in-memory unlocked
state — the cache extends the *duration* of that window for
convenience, it does not introduce a new attack surface.

The threat the header comment was actually warning about — a
"plaintext-seed-equivalent at rest" — does not apply, because
`storage.session` is not "at rest."

### What shipped now (doc-only)

Rewrote the `keystore.ts` file header to honestly describe:

1. On-disk keystore is always encrypted (PBKDF2 + XChaCha20-Poly1305).
2. The opt-in auto-unlock cache exists, stores plaintext mnemonic
   in `chrome.storage.session`, and what its lifecycle is.
3. The Chrome-level guarantees that make this acceptable
   (in-memory only, per-extension partition, browser-close eviction).
4. The actual residual threat (process-memory disclosure) and
   that the cache does not change it qualitatively, only
   quantitatively.
5. A forward-reference to the planned v0.3.x wrapped-key
   re-architecture.

No runtime code changed. No tests changed.

### Planned fix (v0.3.x re-architecture)

Replace the mnemonic-in-`storage.session` cache with a
**wrapped-key** approach:

1. During the unlock ceremony, derive a short-lived AES-256
   "wrapping key" via `crypto.subtle.generateKey` (non-extractable,
   usage `wrapKey`/`unwrapKey`).
2. Use that wrapping key to encrypt the *seed bytes* (not the
   mnemonic) and store the wrapped ciphertext in
   `chrome.storage.session` under `SESSION_CACHE_KEY`.
3. Hold the wrapping `CryptoKey` handle in service-worker memory
   only. On SW restart, the wrapping key is gone and the cache is
   useless ciphertext until the user re-enters their password.
4. Drop the mnemonic string reference immediately after the
   wallet is built — the cache no longer needs it. (The
   `rebuildUnlockedFromMnemonic` helper goes away; replace with
   `rebuildUnlockedFromSeed` that takes raw seed bytes.)

Net effect:

- Process-memory disclosure attack now recovers a *wrapped blob*
  plus a non-extractable `CryptoKey` handle. WebCrypto's
  `extractable: false` flag means even a debugger cannot exfiltrate
  the wrapping key material directly — they must exercise the
  `unwrapKey` API in-context, which raises the attacker's bar
  meaningfully.
- The recovery phrase (the thing a user types into another wallet
  to drain their funds) never sits in `storage.session` at all.
  A heap snapshot can still observe the seed bytes briefly during
  derivation, but the user-recoverable mnemonic string lifetime
  collapses to the unlock-ceremony itself.
- SW restart within an `autoLockMinutes` window stops being
  "silent auto-unlock" and becomes "silent auto-unlock until the
  SW dies, then re-prompt" — slightly worse UX, materially better
  threat model. Acceptable tradeoff.

Tracked as a v0.3.x item; not blocking any v0.3.0 ship work.

---

## 2026-06-04 — Pre-v0.3.0 ship audit (four fund-safety / integrity entries)

A deep audit of every tip / swap / send / claim / clawback flow
surfaced thirteen findings ranging from CRITICAL fund loss to
defensive hardening. All thirteen shipped fixes before v0.3.0
release. The four with security or fund-safety impact are recorded
here; the rest are tracked in the private TODO.md (defensive
plumbing, none of them user-visible).

### 1. Clawback was backend-only — funds orphaned at tip address (CRITICAL)

**Severity:** Critical (fund loss)
**Reporter:** discovered live during dogfood by johnwmurphy
**Status:** Fixed before v0.3.0 release. One affected on-chain
orphan (11 GRIN) was recovered via URL-paste public-claim during
the same session.
**Commits:** `e76e26e` (on-chain sweep in
[`packages/extension/src/popup/tip-claim-handler.ts`](../packages/extension/src/popup/tip-claim-handler.ts)),
`7ac6131` (popup wiring in
[`packages/extension/src/popup/index.tsx`](../packages/extension/src/popup/index.tsx)).
Backend race-fix tracked separately in
[smirk-backend `5aa91ea`](https://github.com/jwinterm/smirk-backend/commit/5aa91ea).

#### What was wrong

v0.3.0 shipped `clawback_social_tip` as a single
`await api.clawbackSocialTip(tipId); await removeTipKeyBackup(tipId)`
in the popup. The backend marked the tip as `status='clawed_back'`
and the local key backup was deleted, but **no on-chain action
ever ran**. Funds stayed at the tip address with no path to
recovery — the backend reported "recovered" while the wallet's
balance never moved.

Affected ALL 5 chains (BTC, LTC, XMR, WOW, Grin). The wallet
silently lost any unclaimed tip that the sender attempted to
clawback.

The legacy `smirk-extension` v0.2.4 had the correct flow — the
v0.3 monorepo rewrite dropped the on-chain sweep step during the
port and the regression went un-caught through dogfood until a
user happened to clawback a public Grin tip and noticed the
balance didn't move.

#### What shipped

Ported v0.2.4's flow into `tip-claim-handler.ts` as
`clawbackSocialTip`:

1. Look up local tip-key backup by `tipId`.
2. Decrypt the per-tip key material using the wallet's BTC
   private key (symmetric, same `deriveStorageKey(btc)` as
   storage).
3. Per-asset sweep `tipAddress → wallet.addresses[asset]` using
   the same `sweepUtxo` / `sweepXmrWow` / `sweepGrin` helpers
   that the recipient claim flow uses (destination differs,
   on-chain operation is identical).
4. Best-effort `api.clawbackSocialTip(tipId)` to mark the
   backend state — funds are already moved on-chain, so a backend
   failure here is non-fatal.

Backend side: `clawback_social_tip` now accepts `status='claiming'`
in addition to `'pending'` (guarded by `sweep_confirmed_at IS NULL`)
so a recipient-vs-sender race where the recipient calls
`mark_tip_claiming` first doesn't make the sender's Clawback fail
with a misleading "Tip not found" error after the on-chain sweep
already succeeded.

#### Impact assessment

Any clawback attempted on a v0.3.0 build prior to this fix
silently orphaned the funds at the tip address. The wallet user
retains:

- **Recovery via the new clawback flow** if the local tip-key
  backup is still present (it was removed by the broken flow, but
  if the user upgraded to the fixed build before their next
  clawback attempt their backup survives).
- **Recovery via URL re-paste** for public tips if the user
  preserved the share URL (e.g. via the Tip Sent screenshot).
- **Manual backend reset + claim** if neither of the above —
  contact support with the tip id.

For the 0-to-N affected production users prior to v0.3.0 release:
this code path was only on dogfood builds. No public release ever
shipped with the broken clawback. The 11 GRIN orphan that surfaced
the bug was recovered same-session.

#### Lessons

1. **Port-or-rewrite parity tests.** Critical-path flows that
   already exist in production should have a "port checklist"
   that the rewrite has to satisfy before the old flow can be
   removed. Clawback shipped with the backend-flip part of the
   v0.2.4 flow and dropped the on-chain part — the reviewer would
   have caught that with a one-page mapping.
2. **Dogfood discipline.** The bug was found live, not in
   review. That's a good outcome (caught before public ship) but
   the only reason it surfaced is the user happened to clawback a
   tip and notice the balance. Future ship audits should
   explicitly exercise every recovery path on every chain, not
   just the happy paths.

### 2. ApprovalApp shipped without `ensureWasmInit()` — cross-chain dapp claims broken

**Severity:** High (functional regression; UTXO unaffected)
**Reporter:** discovered live during the clawback recovery flow
**Status:** Fixed before v0.3.0 release.
**Commit:** `7ac6131` (one-line fix in `ApprovalApp.handleApprove` —
[`packages/extension/src/popup/index.tsx`](../packages/extension/src/popup/index.tsx)).

#### What was wrong

`ApprovalApp` is a separate render root from the main popup,
mounted when the wallet dispatches a `chrome.windows.create(...)`
dapp approval popup. The main popup's unlock path calls
`ensureWasmInit()` eagerly, so every wasm operation in the wallet
UI finds the module pre-loaded. The dapp-approval popup never
went through that path. Every `window.smirk.claimPublicTip()` or
`requestPayment` for Grin / XMR / WOW hit a cold WASM binding and
failed with `Cannot read properties of undefined (reading
'__wbindgen_free')`.

UTXO-only payments (BTC / LTC) slipped through because
`@scure/btc-signer` is pure JS — no WASM needed.

#### What shipped

One-line `await ensureWasmInit()` at the top of
`handleApprove` in ApprovalApp. Idempotent (memoised init
promise) so subsequent dispatches pay zero overhead.

#### Impact assessment

Any user attempting to claim a Grin / XMR / WOW public tip from
the smirk.cash URL during the dogfood period saw an opaque WASM
error instead of a successful claim. Tip funds remained at the
tip address; user could recover by retrying once the build with
the fix was loaded. No fund loss; pure functional regression.

No public release shipped with this regression.

### 3. Balance snapshot serializer corrupted `BigInt` values on second refresh

**Severity:** Medium (data integrity; surfaced as UI corruption,
no fund-loss path)
**Reporter:** discovered live during the BigInt-mixing throw
**Status:** Fixed before v0.3.0 release.
**Commit:** `7ac6131` (snapshot read/write helpers in
[`packages/extension/src/popup/index.tsx`](../packages/extension/src/popup/index.tsx)
— cache key bumped from `_v1` to `_v2`).

#### What was wrong

The balance snapshot cache (popup-side, `chrome.storage.session`)
wrote `Balances` objects with `BigInt` fields directly. On Brave,
the round-trip through structured-clone silently stringified the
BigInts on write — round-trip integrity wasn't preserved.

On second refresh after popup restart, the snapshot's restored
values were strings while the freshly-fetched values from
`fetchAllBalances` were BigInts. Subsequent arithmetic
(`b.pending > 0n`, `b.confirmed + b.pending`) threw `Cannot mix
BigInt and other types, use explicit conversions`. The throw
landed mid-render in Preact, which left the reconciliation
half-broken so the next route change rendered the AppShell twice
side-by-side (the "Settings doubling" bug).

#### What shipped

Explicit `BigInt → string` on snapshot write and
`string → BigInt` on read. Bumped the cache key from
`smirk_balance_snapshot_v1` to `_v2` so pre-fix entries don't
poison the new readers. No reliance on structured-clone BigInt
preservation anywhere.

#### Impact assessment

User-visible as UI corruption (the "Settings doubling" screenshot
the user reported) plus a console throw on each refresh. No
fund-loss path: the on-chain reality is the source of truth and
the throw didn't cause any incorrect tx to be broadcast.

No public release shipped with this bug.

### 4. dapp public-cache had no session-expiry — false `isUnlocked` after auto-lock

**Severity:** Medium (UX; the user-visible symptom was a 3-click
claim flow, not a security boundary failure)
**Reporter:** discovered live during the clawback recovery flow
**Status:** Fixed before v0.3.0 release.
**Commit:** `09d9251` —
[`packages/extension/src/background/dapp/provider.ts`](../packages/extension/src/background/dapp/provider.ts)
gained the expiry check;
[`packages/extension/src/popup/index.tsx`](../packages/extension/src/popup/index.tsx)
writes the `sessionExpiresAtMs` field on cache populate.

#### What was wrong

`DappPublicCache` (the `chrome.storage.local` blob the SW dapp
provider reads to answer `isUnlocked` / `getAddresses` /
`getPublicKeys`) only knew "is the cache present". The popup
wrote on unlock and cleared on lock, but those handlers only fire
when the popup is OPEN. When the session auto-lock TTL expired
with the popup closed, the cache stayed populated and the SW
provider returned `isUnlocked = true` even though
`walletKeystore.getState()` would say `locked` on the next read.

User-visible symptom: claiming a tip via `smirk.cash` with an
auto-locked wallet took 3 clicks — first opened the approval
popup with `LockScreen` (because the actual keystore is locked,
even though the dapp adapter thought the wallet was unlocked),
user unlocked, then a second site click bounced "unlock first"
(because the original dapp-API request had already failed at
`assertUnlocked` before the SW received the unlock signal), then
a third click finally succeeded.

Note: this is NOT a security boundary failure. The SW only ever
reports *public* material from the cache. Asking it for keys or
signatures still requires a fresh approval-popup flow that pulls
the real unlocked wallet from the main popup process. A
falsely-reported `isUnlocked = true` doesn't leak any unlocked
key material; it just confuses the dapp-side wait-for-unlock
prompt.

#### What shipped

`DappPublicCache` gained an optional `sessionExpiresAtMs` field
stamped at write time from the popup's `autoLockMinutes` setting.
The SW provider's `readCache()` now treats entries with
`sessionExpiresAtMs < Date.now()` as expired, GCs them from
storage, and returns `null` (= locked). Backward-compatible with
pre-fix cache entries (no `sessionExpiresAtMs` field) which fall
through to the legacy "presence == unlocked" behaviour.

#### Impact assessment

No fund loss, no key leak, no unauthorized signature path. UX
papercut for anyone using a dapp-integrated wallet flow with
auto-lock enabled.

No public release shipped with this bug.

---

## 2026-05-10 — `outgoing_view_key` hardcoded to zero (XMR/WOW signing)

**Severity:** High (privacy regression, no key compromise)
**Reporter:** community reviewer, via johnwmurphy
**Status:** Fixed in monorepo before any release; back-ported to legacy
`smirk-wasm-monero` for the in-production extension.

### What was wrong

`crates/smirk-wasm/src/signing.rs` (lifted verbatim from the pre-monorepo
`smirk-wasm-monero` package) constructed every Monero/Wownero
`SignableTransaction` with:

```rust
// Create outgoing view key (32 bytes of zeros for now - this is used for
// deterministic output key generation, not critical for basic signing)
let outgoing_view_key = Zeroizing::new([0u8; 32]);
```

The comment was wrong. Per [`monero-oxide/wallet/src/send/mod.rs:417-419`](../crates/monero-oxide/monero-oxide/wallet/src/send/mod.rs):

> `outgoing_view_key` is used to seed the RNGs for this transaction.
> Anyone with knowledge of the outgoing view key will be able to identify
> a transaction produced with this methodology, and the data within it.
> Accordingly, **it must be treated as a private key**.

By passing zeros, every Smirk-signed transaction used a publicly known
RNG seed. Concretely:

1. The per-tx scalar `r` (transaction private key) was deterministic.
2. With `r` known, an observer can compute `r·B_recipient` — the same
   ECDH shared secret the receiver derives — and decrypt the encrypted
   amount, derive the same stealth one-time output key, and link the
   output to the recipient's view key.
3. CLSAG signatures themselves remained valid (the spend key was not
   compromised), so chain validation never noticed.

In practice, **all historical XMR and WOW outgoing transactions from
Smirk users have zero amount privacy beyond what an on-chain observer
already sees**. Receiver identification is also possible for any
observer with the recipient's view key, since the deterministic shared
secret reveals the link.

### What was right (scope bounding)

- monero-oxide upstream is not affected — the API correctly requires
  `outgoing_view_key` as a parameter and warns it must be private.
- Spend keys were never leaked.
- Bitcoin / Litecoin / Grin signing paths use independent code and were
  not affected.

### Fix

`fresh_outgoing_view_key()` in
[`crates/smirk-wasm/src/signing.rs`](../crates/smirk-wasm/src/signing.rs)
generates 32 bytes from `OsRng` per call:

```rust
pub(crate) fn fresh_outgoing_view_key() -> Zeroizing<[u8; 32]> {
    use rand_core::RngCore;
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    Zeroizing::new(bytes)
}
```

Per-tx randomness (rather than deterministic derivation from the spend
key) was chosen because the upstream API explicitly warns: *"If one
`outgoing_view_key` is reused across two transactions which share keys
in their inputs, ... ephemeral secrets MAY be reused causing adverse
effects."* That's CLSAG nonce reuse → spend-key leakage. Per-tx
randomness makes that footgun unreachable.

### Regression test

`tests::tests::test_outgoing_view_key_is_fresh_per_call` in
[`crates/smirk-wasm/src/tests.rs`](../crates/smirk-wasm/src/tests.rs)
calls the helper 256 times and asserts:

- No call returns `[0u8; 32]`.
- All 256 returned keys are distinct (i.e., the source is fresh
  randomness, not a deterministic function of any in-scope value).

If anyone re-introduces a constant or deterministic source, this test
fails before the build can ship.

### Audit of similar issues

Triggered a full sweep of:

- `crates/smirk-wasm/src/` — clean. Every other `[0u8; N]` is a
  destination buffer immediately filled by `copy_from_slice` /
  `fill_bytes` / `hex::decode_to_slice`.
- `crates/smirk-wasm/src/grin/{schnorr,adaptor,blind,bulletproof,
  multiparty,slate_builder}.rs` — these accept caller-supplied nonces
  by hex; nonce uniqueness is the JS caller's contract (correctly
  documented). Not a defect in this crate.
- `packages/core/src/crypto.ts` — `randomBytes` is from
  `@noble/hashes/utils`, which delegates to `crypto.getRandomValues`.
  Clean.
- `packages/core/src/hd.ts:428` — `Math.random` for picking which seed
  words to quiz the user on during onboarding verification UI. Not
  cryptographic; user's seed itself is generated with proper entropy
  elsewhere. Clean.
- Legacy `smirk-extension/src/lib/grin/` JS callers — slatepack uses
  `crypto.getRandomValues`, schnorr/adaptor signing uses
  `Secp256k1Zkp.createSecretNonce` (RFC6979). Clean.

### Class lessons

1. Comment-marked deferrals like `// for now` and `// not critical`
   near anything load-bearing for crypto are the danger pattern.
   Treat them as suspect, especially when they touch a third-party
   library API whose own docs say the parameter is privacy-sensitive.
2. Where the failure mode is silent (signing still works, chain
   accepts it), regressions can ship undetected. Pin the security
   contract with a unit test, not just a comment.
3. Independent community reviewers catch what we don't. Fast triage
   path: read the upstream docs first, hypothesize-then-verify, fix +
   regression test before scope-creeping into related issues.

### Disclosure / user-facing

The legacy extension may not get another release before the monorepo
v0.3 ships. Decision pending on whether to coordinate disclosure to
existing users — if any future XMR/WOW privacy claims have been made
publicly, they should be qualified for the affected version range.
