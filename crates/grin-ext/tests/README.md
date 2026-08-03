# `grin-ext` validation strategy

This crate implements the Grin slate / slatepack / kernel ceremony from
scratch (not a fork). The unit tests in `src/**/tests` verify internal
correctness — given inputs we control, do our functions produce the
output we expect? — but they can't catch **protocol mismatch** bugs: a
sign convention that's internally consistent but doesn't match what
the Grin network requires when verifying the on-chain kernel commitment.

(See commit `c78aff0` for an example: the `sender_blind_excess`
function returned `inputs − outputs − offset` instead of `outputs −
inputs − offset`. All 100+ internal tests passed because sender and
receiver used the same wrong convention, but the resulting kernel
public key would not match what the network derives from on-chain
commitments. A real mainnet broadcast would have failed.)

## Strategy

Cross-validate every load-bearing primitive against the **official
`grin_wallet_libwallet`** reference implementation. The reference is a
pinned public git dev-dependency (see `Cargo.toml::dev-dependencies`),
so the workspace resolves from a clean clone with no sibling checkout
required.

For each primitive we own:

1. Build the output with our crate.
2. Round-trip through `grin_wallet_libwallet`'s parser
   (`Slate::deserialize_upgrade(&json)`).
3. Verify the parsed struct has the expected version / participant
   count / kernel features.
4. Where the reference exposes a verification helper
   (e.g. `slate.calc_excess(&secp)` to compute the kernel excess
   commitment), cross-check it against our crate's derivation.

Tests live in `tests/grin_wallet_compat.rs`. They're behind the default
dev-profile compile but excluded from release wasm builds — the dep is
listed under `[dev-dependencies]`, not `[dependencies]`.

## What this catches

- **Slate format drift**: our serialized JSON / binary fields disagree
  with what `grin_wallet_libwallet` reads.
- **Kernel-excess math errors**: the public key our sender derives is
  not what the reference computes from the same inputs.
- **Bulletproof / Pedersen commitment incompatibilities**: the
  reference can verify our commitments and proofs.
- **Participant data shape**: number of participants, sig slot
  conventions.

## What this does NOT catch

- **Wire-level bugs in slatepack ASCII armor**: the armor codec is
  tested separately in `slatepack::tests`.
- **Network-relay / mempool propagation bugs**: those need a real
  mainnet round-trip; see `docs/SEND_FLOW.md`, "Testing strategy: small
  mainnet amounts, no testnets".
- **Subtle nonce-reuse bugs**: we test with deterministic nonces
  to get reproducible fixtures; the production code uses fresh OS
  randomness. The "fresh nonce per slate" invariant is verified by
  inspection.

## How to add a new validation test

```rust
#[test]
fn our_slate_v4_parses_in_grin_wallet() {
    use grin_wallet_libwallet::Slate;

    // 1. Build a slate with our crate.
    let our_slate: grin_ext::SlateV4 = /* ... */;
    let json = grin_ext::serialize_slate_v4(&our_slate).unwrap();

    // 2. Parse via the reference implementation.
    let ref_slate = Slate::deserialize_upgrade(&json)
        .expect("grin_wallet_libwallet should accept our slate JSON");

    // 3. Cross-check fields.
    assert_eq!(ref_slate.amount, our_slate.amt);
    assert_eq!(ref_slate.fee_fields.fee(0), our_slate.fee);
}
```

## The reference dependency

No local setup is required: `cargo test -p grin-ext` fetches the pinned
reference automatically. To move the pin, bump the `rev` in
`Cargo.toml::dev-dependencies`.
