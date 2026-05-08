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
| Pedersen commitments + Bulletproofs (BP) | ✅ Done — vendored `grin_secp256k1zkp` v0.7.15, patched for wasm32; create + verify + rewind round-trip in tests |
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
| `grin_pedersen_commit(value, blinding_factor_hex)` | `hex` — 33-byte Pedersen commitment |
| `grin_bullet_proof_create(value, blinding_factor_hex, rewind_nonce_hex, private_nonce_hex)` | `hex` — variable-length BP range proof |
| `grin_bullet_proof_verify(commit_hex, proof_hex)` | `bool` — true if BP is valid for the commitment |
| `grin_bullet_proof_rewind(commit_hex, rewind_nonce_hex, proof_hex)` | `JSON: { value, blinding_factor_hex }` or `null` if rewind nonce doesn't match |
| `grin_ext_version()` | grin-ext crate version string, for runtime version checks |

More exports land as the underlying `crates/grin-ext/` surface grows.

## Bulletproofs (BP) — implemented via vendored secp256k1zkp

**Grin uses the original Bulletproofs (BP), not BP+.** Confirmed in
`grin/core/src/libtx/proof.rs`, which calls `secp.bullet_proof(...)` /
`secp.verify_bullet_proof(...)` — wrappers over `secp256k1_bulletproof_*`
in the C library. BP+ was discussed for Grin but never adopted.

The implementation lives at `crates/secp256k1zkp/` — a vendored copy
of `grin_secp256k1zkp` v0.7.15 (Grin's fork of `rust-secp256k1-zkp`).
Upstream `secp256k1-zkp` 0.11 only binds the legacy Borromean range
proof API; Grin's fork adds bindings for `bullet_proof` /
`verify_bullet_proof` / `rewind_bullet_proof`, which is what we need.

### What we patched for wasm32

The vendored crate didn't compile to `wasm32-unknown-unknown` out of
the box (it predates browser-WASM as a target). Three changes:

1. **`wasm-sysroot/`** — minimal libc forward-declaration headers
   (`string.h`, `stdlib.h`, `stdio.h`) so clang's wasm32 frontend can
   compile the C source. Memcpy/memset/memcmp resolve to LLVM
   compiler-rt builtins at link time. Pattern borrowed from upstream
   `secp256k1-zkp-sys`. See `crates/secp256k1zkp/wasm-sysroot/README.md`.
2. **`build.rs`** — added `base_config.include("wasm-sysroot")` when
   `CARGO_CFG_TARGET_ARCH == "wasm32"`.
3. **Rust source** — replaced `libc::size_t` (not exported on
   wasm32-unknown-unknown by the `libc` crate) with a local
   `type size_t = usize;` alias in the four files that used it
   (`ffi.rs`, `lib.rs`, `aggsig.rs`, `pedersen.rs`). `libc::c_int`,
   `libc::c_uchar`, `libc::c_uint`, `libc::c_void` swapped to
   `core::ffi::*` (stable since Rust 1.64).

All patches are localized and labeled with `// Smirk patch:` comments
so future `git subtree pull` from upstream can re-apply cleanly.

### Side benefit

The vendored crate also exposes `aggsig` (Grin's Schnorr) and `ecdh`
beyond what we currently use. If we ever want byte-equivalent Schnorr
sigs with `grin-wallet` (instead of our pure-Rust k256 implementation),
the binding is right there.

## Reference

- `crates/grin-ext/src/seed.rs` — current implementation
- `crates/grin-ext/src/seed.rs::tests` — golden vectors with independently-verified expected values
