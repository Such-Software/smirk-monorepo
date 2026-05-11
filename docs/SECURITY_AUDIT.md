# Security Audit — 2026-05-10

Internal sweep triggered after the OVK privacy bug
([SECURITY_LOG.md](SECURITY_LOG.md)) was reported by a community
reviewer. Three lanes ran in parallel — extension ↔ backend
communications, data input handling, data storage.

Internal audit is not adversarial review. It catches the obvious. A
formal external code audit + pen test is queued for v1.0 prep.

## Scope

Primary: monorepo (`smirk-monorepo/packages/extension`,
`smirk-monorepo/packages/core`) — what v0.3 ships with.

Cross-reference: legacy `smirk-extension/` — what's currently in
production with 61 users — to identify *patterns we must not inherit*
when we port code over.

Out of scope: backend Rust code, vendored monero-oxide, vendored Grin
libs.

## Headline finding

The monorepo extension is currently a small skeleton — most of the
attack surface (slatepack parsing, `window.smirk` dApp API, content-
script messaging, storage of secret material) lives only in legacy and
hasn't been ported yet. That makes the monorepo *shallow* but not
*safe*: when those modules get ported, they will inherit the legacy's
findings unless we re-architect.

So this doc has two halves: **monorepo issues to fix now** (small) and
**legacy patterns to NOT inherit** (the actual punch list for the
next several PRs).

---

## Monorepo — fixed in this commit

### M1 — `core/api/client.ts` request/response body logging
**Severity:** High
**Status:** Fixed

A `DEBUG_ENDPOINTS` list at the top of the API client was used to
`console.log` full request and response JSON for `/grin/`,
`/tips/social`, and `/prices`. No build flag gated it. Logged content
included `encrypted_key` (the only secret protecting public-tip
ciphertext), full slatepack payloads, and view-key-adjacent values.

Browser console output is exposed via crash dumps, screen-share
screenshots, and any extension with devtools-tab access — defense in
depth was lower than intended.

**Fix:** removed the `DEBUG_ENDPOINTS` mechanism entirely. Replaced
with a `// SECURITY:` banner blocking re-introduction. For ad-hoc
debugging, the Chrome DevTools Network panel shows the same content
on demand and is per-developer rather than baked into shipped code.

### M2 — Stub wallet ops in popup
**Severity:** Medium (would be Critical if it shipped)
**Status:** Fixed (build-time guard added)

`popup/index.tsx` carries `stubValidateAddress` (accepts ≥4 chars),
`stubResolveAddress` (returns a fake string), and `stubSubmit` (sleeps
+ returns success). They exist so the popup can be exercised visually
before the real wallet wiring lands. **Shipping any of them would be
disastrous** — Send would happily build txs against typo'd / phished
addresses.

**Fix:** added a runtime guard at module load:

```ts
if (import.meta.env.VITE_SMIRK_RELEASE === 'true') {
  throw new Error('[smirk] stub wallet ops detected in a release build…');
}
```

`VITE_SMIRK_RELEASE` is not set during normal `npm run build:chrome`
(developer dev/smoke builds). It is set only by the release pipeline.
A release build with stubs still present produces a popup that throws
at module load — Chrome refuses to render it, so the bug is loud and
unmissable.

The guard is one half of a defense-in-depth plan; the other half is
that the stubs get replaced before release anyway. But this catches
the case where someone forgets.

### M3 — Missing XMR / WOW / Grin address validators
**Severity:** Low (foot-gun shaped hole)
**Status:** Fixed

`packages/core/src/address.ts` had `isValidBtcAddress` and
`isValidLtcAddress` but no validators for XMR, WOW, or Grin slatepack —
only generators. When `SendWizard` wires up real validation, the
risk is that a caller reaches for what exists and quietly accepts
"can't validate" as "valid".

**Fix:** added `isValidXmrAddress`, `isValidWowAddress`, and
`isValidGrinSlatepackAddress`. The two Cryptonote validators decode
Monero base58, verify the trailing 4-byte Keccak-256 checksum, and
require the leading varint to match an allowed prefix
(standard / integrated / subaddress). The Grin validator does bech32
(non-bech32m) decode with hrp `grin` and asserts the payload is 32
bytes (an ed25519 public key).

Regression tests in `packages/core/src/__tests__/address.test.ts`
cover round-trip, single-char tampering (checksum failure), wrong-
network rejection, malformed input, and a cross-asset matrix that
asserts each validator only accepts its own family.

### M4 — `parseAmount` input length
**Severity:** Low (UI hang, not security)
**Status:** Fixed

`parseAmount` in the popup had no upper bound on input length. A
multi-megabyte pasted "9999…" string would build a multi-megabyte
BigInt, hanging the popup. Not exploitable beyond local DoS, but
trivially fixed.

**Fix:** reject inputs longer than 32 characters before regex parsing.
Any sane on-chain amount fits well within that limit.

---

## Legacy — DO NOT INHERIT when porting

These live in `~/src/smirk-extension/` (production today). Tracked
here so that when the corresponding feature gets ported into monorepo,
we re-architect rather than copy-paste. Saved as memory entries so
agent-driven porting work catches them.

| Lane | Sev | Pattern | Required design change |
|------|-----|---------|------------------------|
| Storage | **CRIT** | Plaintext mnemonic + spend keys + view keys in `chrome.storage.session`. Survives SW restart, visible in `chrome://extensions` Storage pane. | Persist only an ephemeral session unwrap key (or accept re-prompt on SW restart). Never write seed-derived material plaintext to *any* `chrome.storage` backend. |
| Storage | **CRIT** | Refresh token plaintext in `chrome.storage.local`. Survives browser close + uninstall residue. Profile-dir read = unbounded re-auth. | Encrypt with password-derived key, OR drop the refresh token entirely and re-auth via signed challenge per unlock (the legacy code already has this fallback path). |
| Storage | **High** | `setAccessToken(null)` not called on lock. JWT survives lock semantics. | Add to `clearInMemoryKeys()`. |
| Comms | **High** | `inject/smirk-api.ts` posts to `'*'` instead of `window.location.origin`. Cross-origin iframes (ad slot, embed) on a connected dApp can read every `connect` / `signMessage` / `requestPayment` request. | Use `window.location.origin` on every `window.postMessage`. |
| Comms | **High** | `connect()` is all-or-nothing. Phishing site can request all five assets with one user click. | Per-asset checkbox UI in the approval popup, default to least-privilege. |
| Comms | **Medium** | No `Idempotency-Key` on createTip / createSocialTip / claimTip / claimSocialTip. SW restart mid-flight, HTTP/2 proxy retry, or transparent network double-send creates duplicate state. | Coordinate with backend: client-generated UUID v4 in `Idempotency-Key` header; server-side dedupe + cached response. |
| Storage | **Medium** | PBKDF2 600K upgrade has half-migration window. Transient WebCrypto failure can leave `pbkdf2Iterations=600000` + new salt + old ciphertext → permanent seed-reveal lockout for that wallet. | Bail out of upgrade entirely if `unlockedMnemonic`/`unlockedSeed` is unavailable. Stage all re-encryption in a local object before the single `saveWalletState`. |
| Storage | **Medium** | Decrypted secret buffers (`Uint8Array` of spend keys, view keys, BIP39 seed) not zeroed before reassignment. GC keeps them in heap until next compaction. | `unlockedKeys.forEach(v => v.fill(0))` before `clear()`. Mnemonic strings are unfixable in JS — discard them as soon as derived keys exist. |
| Comms | **Low** | Auth signature only binds timestamp, not keys/username. | Include `hash(keys || username)` in the signed message. |

## False positives

For posterity, things that were flagged in scope and confirmed safe:

- No plain `http://` URLs anywhere in scope.
- No CSRF on GET — every state-changing endpoint is POST.
- No `innerHTML` on error paths — error strings are surfaced via Preact text nodes.
- No token in URL params — Bearer header only.
- `JSON.parse` calls in `core` operate on data we ourselves stringified one frame earlier.
- `snakeToCamel` recursion in `core/api/parse.ts` doesn't have a prototype-pollution path because it builds a fresh literal object per call (modern JS literal-property assignment doesn't write `__proto__`).
- The `[0u8; 32]` patterns elsewhere in `crates/smirk-wasm/src/` are mutable buffers populated immediately by `copy_from_slice` / `fill_bytes` / `hex::decode_to_slice`. Only the one OVK case (now fixed in `SECURITY_LOG.md`) was the bug.

## Process notes

What worked: parallel subagents per lane with tight scope and a
700-word findings cap. Same format that found the OVK fix scope.

What we should do next:
- Rerun this same audit *after* the legacy → monorepo port lands for
  each module (slatepack, dApp API, key storage). The patterns above
  are the things to grep for during review.
- Sometime before v1.0: external code audit + pen test. The internal
  sweep is a filter, not a substitute.
- Consider a fuzz harness for slatepack parsing and the Grin
  schnorr/adaptor JS-callable functions when those land in monorepo
  (they take caller-supplied nonces — bad randomness from JS leaks
  the secret key in CLSAG / Schnorr).
