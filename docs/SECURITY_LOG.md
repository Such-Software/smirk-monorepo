# Security Log

Chronological record of cryptography- or privacy-relevant fixes in the
monorepo. New entries on top.

---

## 2026-05-10 — `outgoing_view_key` hardcoded to zero (XMR/WOW signing)

**Severity:** High (privacy regression, no key compromise)
**Reporter:** Luke (community), via johnwmurphy
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
3. Independent reviewers like Luke catch what we don't. Fast triage
   path: read the upstream docs first, hypothesize-then-verify, fix +
   regression test before scope-creeping into related issues.

### Disclosure / user-facing

The legacy extension may not get another release before the monorepo
v0.3 ships. Decision pending on whether to coordinate disclosure to
existing users — if any future XMR/WOW privacy claims have been made
publicly, they should be qualified for the affected version range.
