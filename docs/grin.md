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
| Slate construction — sender init (S1) + blind-arithmetic helpers | ✅ Done — produces valid S1 slate matching upstream `init_send_tx` shape; `blind` module covers scalar sum/add/sub/sender_blind_excess |
| Slate construction — receiver round (S2): output Pedersen commit + Bulletproof + receiver partial sig | ✅ Done — partial self-verifies before slate goes back to sender |
| Slate construction — sender finalize (S3): aggregate partials + verify final kernel signature | ✅ Done — full S1→S2→S3 ceremony tested end-to-end including NRD kernels |
| Slate construction — invoice flow (I1/I2/I3): receiver-initiated transactions for "pay this invoice" UX | ✅ Done — receiver_init_i1 / sender_round_i2 / receiver_finalize_i3, full ceremony tested end-to-end |
| Transaction wire-format assembly | ✅ Done — `slate_to_transaction_bytes()` converts a finalized S3 slate + sender's local UTXOs/change + aggregated kernel sig into the binary TX bytes Grin daemons accept on `push_transaction`. Single-kernel transactions (every standard send + invoice flow). |
| Slatepack codec — ASCII armor (`BEGINSLATEPACK...ENDSLATEPACK` envelope, base58check, word-wrap) | ✅ Done — verified against a real `grin-wallet` fixture |
| Slatepack codec — binary `SlatepackBin` payload format (version, mode, sender, payload) | ✅ Done — real `grin-wallet` fixture parses + lossless round-trip |
| Slatepack codec — age encryption to recipient slatepack address (mode 1) | ✅ Done — encrypt/decrypt round-trip via age::Encryptor; ed25519↔X25519 conversion matches grin-wallet (SHA-512 → first 32 bytes for the secret, Edwards→Montgomery for the pubkey). Empty encrypted_meta block; populating with sender/recipients is a follow-up. |
| NRD kernel construction (sig message + v2 wire format for plain / coinbase / height-locked / NRD) | ✅ Done — sig msg composes with Schnorr round-trip; range-checked (NRD relative_height ∈ [1, 10080]) |
| Multi-party Schnorr aggregation (Grin-style aggsig: partial sign + verify + aggregate, no key-coefficient tweaks) | ✅ Done — 2-party + 3-party round-trip tests pass |
| Adaptor-signature variants of slate signing | ✅ Done — Schnorr adaptor sign/verify/complete/extract over secp256k1; full 2-party atomic-swap round-trip tested end-to-end (Bob's adaptor partial → Alice verifies → completion with `t` → aggregation → final Schnorr verifies → watcher extracts `t`) |

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
| `grin_point_add(a_hex, b_hex)` | `hex` — sum of two compressed pubkeys (point addition) |
| `grin_point_sum(points_concat_hex)` | `hex` — sum of N concatenated compressed pubkeys |
| `grin_schnorr_partial_sign(sk, nonce, R_total, P_total, msg)` | `hex` — partial scalar `s_i` for one participant |
| `grin_schnorr_partial_verify(s_i, R_i, P_i, R_total, P_total, msg)` | `bool` — verify a partial signature |
| `grin_schnorr_aggregate_partials(partials_concat_hex)` | `hex` — sum of N partial scalars (mod n) |
| `grin_schnorr_final_signature(R_total, aggregate_s)` | `hex` — 64-byte aggregate signature; verify with `grin_schnorr_verify` against `P_total` |
| `grin_kernel_sig_msg(kind, fee?, lock_height?, relative_height?)` | `hex` — 32-byte BLAKE2b message to Schnorr-sign for a kernel of the given type |
| `grin_kernel_features_bytes(kind, fee?, lock_height?, relative_height?)` | `hex` — kernel features in v2 wire format (for slate v4 kernel serialization) |
| `grin_blind_add(a_hex, b_hex)` / `grin_blind_sub` / `grin_blind_sum` | `hex` — secp256k1 scalar arithmetic mod curve order |
| `grin_sender_blind_excess(input_blinds, sender_output_blinds, kernel_offset)` | `hex` — Σinputs − Σoutputs − offset |
| `grin_sender_init_s1(slate_id, amount, fee, kernel_kind, lock_height?, relative_height?, sender_blind_excess, kernel_offset, kernel_nonce)` | `JSON: { slate_json, context }` — produces an S1 slate for the receiver and the private context the sender retains for finalize |
| `grin_receiver_round_s2(s1_slate_json, output_blind, kernel_nonce, bp_rewind_nonce, bp_private_nonce)` | `JSON: { slate_json, context }` — produces an S2 slate (with receiver's output commitment + range proof + partial sig) and the private context the receiver retains |
| `grin_sender_finalize_s3(s2_slate_json, slate_id, amount, fee, kernel_kind, lock_height?, relative_height?, sender_blind_excess, kernel_offset, kernel_nonce)` | `JSON: { slate_json, final_signature_hex }` — produces the S3 slate + the verified 64-byte aggregate kernel signature |
| `grin_adaptor_partial_sign(sk, nonce, R_total_no_t, P_total, T, msg)` | `hex` — adaptor partial signature (incomplete; completable with the secret `t` where T = t·G) |
| `grin_adaptor_partial_verify(s', R_i, P_i, R_total_no_t, P_total, T, msg)` | `bool` — true if the adaptor partial WILL complete to a valid normal partial when combined with `t` |
| `grin_adaptor_complete(s', t)` | `hex` — completed partial scalar; aggregates with other partials into a normal final signature |
| `grin_adaptor_extract_secret(s_completed, s')` | `hex` — recover the adaptor secret `t` from a completed partial; used by atomic-swap watchers once the counterparty publishes |
| `grin_slate_to_transaction_bytes(s3_slate_json, sender_inputs_concat_hex, sender_change_outputs_json, aggregated_signature)` | `hex` — broadcastable Grin TX wire bytes |
| `grin_pubkey_to_commitment(pubkey_hex)` | `hex` — convert a 33-byte secp256k1 pubkey to a Grin Pedersen commitment (prefix swap from 0x02/0x03 to 0x08/0x09) |
| `grin_receiver_init_i1(slate_id, amount, fee, kernel_kind, ...)` | `JSON: { slate_json, context }` — invoice-flow receiver init (I1) |
| `grin_sender_round_i2(i1_slate_json, sender_blind_excess, sender_kernel_nonce)` | `JSON: { slate_json, context }` — sender's response to an invoice (I2) |
| `grin_receiver_finalize_i3(i2_slate_json, ...receiver_context_fields)` | `JSON: { slate_json, final_signature_hex }` — receiver's finalize (I3) |
| `grin_slate_round_trip(slate_json)` | `string` — canonicalized JSON if input is a valid v4 slate, throws otherwise |
| `grin_slate_summary(slate_json)` | `JSON: { id, state, amount, fee, num_participants, num_signed }` for UI display |
| `grin_pedersen_commit(value, blinding_factor_hex)` | `hex` — 33-byte Pedersen commitment |
| `grin_bullet_proof_create(value, blinding_factor_hex, rewind_nonce_hex, private_nonce_hex)` | `hex` — variable-length BP range proof |
| `grin_bullet_proof_verify(commit_hex, proof_hex)` | `bool` — true if BP is valid for the commitment |
| `grin_bullet_proof_rewind(commit_hex, rewind_nonce_hex, proof_hex)` | `JSON: { value, blinding_factor_hex }` or `null` if rewind nonce doesn't match |
| `grin_slatepack_armor(payload_hex)` | `string` — `BEGINSLATEPACK. … . ENDSLATEPACK.` armored block |
| `grin_slatepack_dearmor(armored)` | `hex` — inner payload bytes, after checksum verification |
| `grin_slatepack_bin_encode_plain(inner_payload_hex, sender?)` | `hex` — SlatepackBin v1.0 plaintext-mode binary serialization |
| `grin_slatepack_bin_decode(bin_hex)` | `JSON: { version, mode, sender, payload_hex }` |
| `grin_slatepack_pack_plain(inner_payload_hex, sender?)` | `string` — convenience: SlatepackBin + armor in one call |
| `grin_slatepack_unpack(armored)` | `JSON: { version, mode, sender, payload_hex }` — convenience: dearmor + decode in one call |
| `grin_slatepack_encrypt(payload_hex, recipient_pubkey_hex)` | `hex` — age-encrypt payload bytes for a recipient (32-byte ed25519 pubkey) |
| `grin_slatepack_decrypt(encrypted_payload_hex, secret_key_hex)` | `hex` — decrypt with the recipient's ed25519 secret seed |
| `grin_slatepack_pack_encrypted(inner_payload_hex, sender?, recipient_pubkey_hex)` | `string` — convenience: encrypt + bin (mode=1) + armor in one call |
| `grin_slatepack_unpack_with_secret(armored, secret_key_hex)` | `JSON` — works for both plain and encrypted slatepacks; decrypts when needed |
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
