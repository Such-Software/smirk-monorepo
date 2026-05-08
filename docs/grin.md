# Grin

Smirk's Grin / Mimblewimble support is being reimplemented from primitives into `crates/grin-ext/` so we own the protocol layer end-to-end and can extend it with features (atomic-swap adaptor signatures, NRD-kernel time-locks, custom slate workflows) that don't exist in upstream `grin-wallet`.

The existing [smirk-extension](https://github.com/Such-Software/smirk-extension) v0.2.x ships Grin support via vendored MWC-Wallet WebAssembly, which has been validated against the official `grin-wallet` GUI (a Smirk seed restored in `grin-wallet` recovers the same funds). That implementation serves as the behavioral oracle for the new Rust crate — the new code must produce byte-identical outputs for the same inputs before it cuts over to production.

## Approach

**Reimplement, don't fork.** Audited libraries provide the cryptographic primitives; the Smirk crate owns the protocol-layer code:

| Layer | Source |
|---|---|
| HMAC-SHA512 (key derivation) | `hmac` + `sha2` crates |
| BIP39 (mnemonic ↔ entropy) | `bip39` crate |
| secp256k1 + Schnorr | (planned) `secp256k1` / `secp256k1-zkp` |
| Bulletproofs range proofs (BP, not BP+) | (planned) `secp256k1-zkp` |
| ed25519 (slatepack address) | `curve25519-dalek` (already pulled by `monero-oxide`) |
| Bech32 (slatepack address) | (planned) `bech32` |
| BLAKE2b | (planned) `blake2b_simd` |
| Slate types (V4) | **Smirk** — match upstream byte-for-byte serialization |
| Slate construction logic | **Smirk** — round-trip flow, kernel offset, signature aggregation |
| Slatepack codec | **Smirk** — ASCII armor + age encryption |
| NRD kernel construction | **Smirk** — only-Smirk |
| Adaptor-signature variants | **Smirk** — doesn't exist upstream |

Crypto primitives are well-tested upstream — we don't reimplement them. Protocol logic is ours so we can extend it freely.

## Status

| Surface | Status |
|---|---|
| `mnemonic_to_extended_private_key()` (HMAC-SHA512(`"IamVoldemort"`, raw_entropy)) | ✅ Done — matches `grin-wallet` / Grim derivation |
| `public_key_from_secret_key()` (compressed secp256k1, via `k256` crate) | ✅ Done — independently verified against Node's `crypto` |
| BIP32 CKDpriv child key derivation (hardened + non-hardened) | ✅ Done |
| Slatepack address derivation (`m/0/1/0` → BLAKE2b → ed25519 → bech32) | ✅ Done — verified against Grim GUI for the standard zero-entropy BIP39 test mnemonic |
| Schnorr sign/verify (secp256k1, single-signer) | ✅ Done — round-trip self-consistent; byte-equivalence with grin-wallet sigs not yet validated against fixtures |
| Slate v4 types + JSON round-trip | ✅ Done — parses + re-serializes a real `grin-wallet` fixture without data loss |
| Pedersen commitments + Bulletproofs (BP) | 🔬 Path chosen (`secp256k1-zkp` Rust crate via FFI to libsecp256k1-zkp), implementation pending |
| Slate construction (input/output selection, blinding factors, kernel) | ⬜ Not yet started |
| Slatepack codec (age encryption + ASCII armor) | ⬜ Not yet started |
| NRD kernel construction | ⬜ Not yet started |
| Multi-party Schnorr aggregation (MuSig-style for slate signing) | ⬜ Not yet started |
| Adaptor-signature variants of slate signing | ⬜ Not yet started |

## Key derivation chain

The current `grin-wallet`-compatible derivation (matched by `grin_ext::mnemonic_to_extended_private_key`):

```
mnemonic (12 BIP39 words)
  ↓ BIP39 reverse
raw entropy (16 bytes for 12 words; 32 bytes for 24 words)
  ↓ HMAC-SHA512(b"IamVoldemort", entropy)
extended private key (64 bytes)
  ↓ split
secret key  = bytes[0..32]   (used for blinding factors, signing)
chain code  = bytes[32..64]  (used by addressKey/BIP32-like child derivation)
```

The string `"IamVoldemort"` is the literal HMAC key used by both `grin-wallet` and the MWC reference. We do NOT use the BIP39 64-byte PBKDF2 seed — `grin-wallet` hashes the entropy directly.

## Test methodology

Two-tier verification before any feature ships:

1. **Mathematical reproducibility** — Rust unit tests with golden vectors computed independently (e.g. via Python's `hmac` module). Any HMAC-SHA512 implementation must produce the same bytes given the same inputs.
2. **Behavioral parity with smirk-extension v0.2.x** — once a feature has Rust unit tests passing, verify it produces the same output as the existing TypeScript/MWC stack for the same inputs. Once parity holds across a representative input set, the new code is safe to ship.

## WASM exports

Available now in `crates/smirk-wasm/`:

| Function | Returns |
|---|---|
| `grin_derive_extended_key(mnemonic)` | `JSON: { extended_private_key_hex, secret_key_hex, chain_code_hex }` |
| `grin_secp256k1_public_key(secret_key_hex)` | `hex` — 33-byte compressed pubkey |
| `grin_slatepack_address(mnemonic, index, network)` | `string` — bech32 slatepack address (e.g. `grin1...` mainnet, `tgrin1...` testnet) |
| `grin_derive_keys(mnemonic, network)` | `JSON: { extended_private_key_hex, secret_key_hex, chain_code_hex, public_key_hex, slatepack_address }` (convenience) |
| `grin_schnorr_sign(secret_key_hex, secret_nonce_hex, message_hex)` | `hex` — 64-byte compact Schnorr signature |
| `grin_schnorr_verify(signature_hex, message_hex, public_key_hex)` | `bool` — true if signature is valid |
| `grin_slate_round_trip(slate_json)` | `string` — canonicalized JSON if input is a valid v4 slate, throws otherwise |
| `grin_slate_summary(slate_json)` | `JSON: { id, state, amount, fee, num_participants, num_signed }` for UI display |
| `grin_ext_version()` | grin-ext crate version string, for runtime version checks |

More exports land as the underlying `crates/grin-ext/` surface grows.

## Bulletproofs (BP) implementation path

**Grin uses the original Bulletproofs (BP), not BP+.** Confirmed in
`grin/core/src/libtx/proof.rs`, which calls `secp.bullet_proof(...)` /
`secp.verify_bullet_proof(...)` — wrappers over `secp256k1_bulletproof_*`
in the C library. BP+ was discussed for Grin but never adopted.

The chosen path is the `secp256k1-zkp` Rust crate (v0.11+), which wraps
the canonical libsecp256k1-zkp C library:

- The crate's `RangeProof::new` / `verify` / `rewind` are exactly the
  BP functions Grin uses (the `rewind` API to recover amount + message
  is a BP-only feature; its presence confirms the binding is BP, not BP+).
- Cross-compiles cleanly to `wasm32-unknown-unknown` (verified via spike —
  `cc-rs` cross-compiles the underlying C to wasm32 with no extra setup).
- Byte-equivalent to `grin-wallet` by construction (same C library).
- Side benefit: gives us `aggsig` for Schnorr signatures too — a future
  optimization is swapping our pure-Rust Schnorr for the exact Grin
  byte format if that interop matters.

Implementation effort: ~1 day to add the dep, write a thin Rust wrapper
exposing `RangeProof::new(commit, value, blind, ...)` and `verify`,
add WASM exports, write round-trip tests against fixture proofs from
real grin-wallet outputs.

**Earlier doc revisions in this repo incorrectly described Grin as
using BP+** — that was wrong. Slate types still treat the rangeproof as
opaque hex bytes, which remains correct and unblocks all surfaces that
don't depend on producing or verifying valid range proofs.

## Reference

- `crates/grin-ext/src/seed.rs` — current implementation
- `crates/grin-ext/src/seed.rs::tests` — golden vectors with independently-verified expected values
