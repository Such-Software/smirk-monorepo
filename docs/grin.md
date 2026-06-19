# Grin

Smirk's Grin / Mimblewimble support is being reimplemented from primitives into `crates/grin-ext/` so we own the protocol layer end-to-end and can extend it with features (atomic-swap adaptor signatures, NRD-kernel time-locks, custom slate workflows) that don't exist in upstream `grin-wallet`.

The legacy [smirk-extension](https://github.com/Such-Software/smirk-extension) v0.2.x ships Grin support via vendored MWC-Wallet WebAssembly, which has been validated against the official `grin-wallet` GUI (a Smirk seed restored in `grin-wallet` recovers the same funds). That implementation serves as the behavioral oracle for the new Rust crate — `crates/grin-ext/` must produce byte-identical outputs for the same inputs before it cuts over to production. The v0.3 monorepo (`packages/extension`) is the canonical client going forward; `smirk-extension` is kept frozen as the migration source.

## Approach

**Reimplement, don't fork.** Audited libraries provide the cryptographic primitives; the Smirk crate owns the protocol-layer code:

| Layer | Source |
|---|---|
| HMAC-SHA512 (key derivation) | `hmac` + `sha2` crates |
| BIP39 (mnemonic ↔ entropy) | `bip39` crate |
| secp256k1 + Schnorr | `k256` (pure Rust) for the Schnorr layer; `crates/secp256k1zkp/` (vendored `grin_secp256k1zkp` v0.7.15) for Pedersen / aggsig / Bulletproofs |
| Bulletproofs range proofs (BP, not BP+) | `crates/secp256k1zkp/` — Grin never adopted BP+ |
| ed25519 (slatepack address) | `curve25519-dalek` (also pulled by `monero-oxide`) |
| Bech32 (slatepack address) | `bech32` crate |
| BLAKE2b | `blake2` crate |
| age encryption (slatepack mode 1) | `age` crate (pure Rust, ChaCha20-Poly1305 + scrypt + X25519) |
| Slate types (V4) | **Smirk** — match upstream byte-for-byte serialization |
| Slate construction logic (S1/S2/S3 + I1/I2/I3) | **Smirk** — sender-driven and invoice (receiver-driven) ceremonies |
| Slatepack codec | **Smirk** — ASCII armor + binary `SlatepackBin` + age encryption |
| Kernel construction (Plain / Coinbase / HeightLocked / NRD) | **Smirk** |
| Adaptor-signature variants | **Smirk** — doesn't exist upstream |
| Payment proofs | **Smirk** — ed25519-signed `(amount, kernel_commitment, sender_address)` receipt |
| Transaction wire-format assembly | **Smirk** — finalized slate → broadcastable tx bytes |

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
| Payment proofs — receiver's ed25519-signed receipt over `(amount, kernel_commitment, sender_address)` | ✅ Done — sign + verify, message format matches `grin-wallet/libwallet/src/internal/tx.rs::payment_proof_message`. Useful for dispute resolution, audit trails, escrow, merchant flows |
| Transaction wire-format assembly | ✅ Done — `slate_to_transaction_bytes()` converts a finalized S3 slate + sender's local UTXOs/change + aggregated kernel sig into the binary TX bytes Grin daemons accept on `push_transaction`. Single-kernel transactions (every standard send + invoice flow). |
| Slatepack codec — ASCII armor (`BEGINSLATEPACK...ENDSLATEPACK` envelope, base58check, word-wrap) | ✅ Done — verified against a real `grin-wallet` fixture |
| Slatepack codec — binary `SlatepackBin` payload format (version, mode, sender, payload) | ✅ Done — real `grin-wallet` fixture parses + lossless round-trip |
| Slatepack codec — age encryption to recipient slatepack address (mode 1) | ✅ Done — encrypt/decrypt round-trip via age::Encryptor; ed25519↔X25519 conversion matches grin-wallet (SHA-512 → first 32 bytes for the secret, Edwards→Montgomery for the pubkey). Empty encrypted_meta block; populating with sender/recipients is a follow-up. |
| NRD kernel construction (sig message + v2 wire format for plain / coinbase / height-locked / NRD) | ✅ Done — sig msg composes with Schnorr round-trip; range-checked (NRD relative_height ∈ [1, 10080]) |
| Multi-party Schnorr aggregation (Grin-style aggsig: partial sign + verify + aggregate, no key-coefficient tweaks) | ✅ Done — 2-party + 3-party round-trip tests pass |
| Adaptor-signature variants of slate signing | ✅ Done — Schnorr adaptor sign/verify/complete/extract over secp256k1; full 2-party atomic-swap round-trip tested end-to-end (Bob's adaptor partial → Alice verifies → completion with `t` → aggregation → final Schnorr verifies → watcher extracts `t`) |
| Switch-commitment-aware blind derivation (BIP32 child key → `blind_switch` with the J generator from secp256k1-zkp) | ✅ Done — Grin Hard Fork 2 consensus requirement; byte-equivalent with `grin_keychain::ExtKeychain::derive_key` across 5 cross-validation cases |
| Slate v4 compact-binary serialization (`SlatepackBin` wire format) | ✅ Done — `crates/grin-ext/src/slate_bin.rs` ported from `grin_wallet_libwallet::v4_bin`; binary round-trip verified against the official library |
| **6 high-level wallet orchestrators** in `crates/grin-ext/src/wallet_flows.rs` | ✅ Done — `create_send_transaction`, `sign_incoming_send_slate`, `finalize_send_slate`, `create_invoice`, `sign_invoice`, `finalize_invoice`. Each takes wallet-level params (extended priv key, inputs, amount, fee) and returns slate + context + tx_bytes. Mirror the XMR/WOW pattern where Rust does the signing but TS does the orchestration |
| Cross-validation against `grin_wallet_libwallet` 5.4.0 | ✅ Done — `crates/grin-ext/tests/grin_wallet_compat.rs`: 8 tests covering sign convention, `derive_blind` vs `grin_keychain` (5 cases), full S1→S2→S3 round-trip, full I1→I2→I3 round-trip, binary slate round-trip, random secret nonce. Catches protocol-mismatch bugs that internal tests can't (e.g. the c78aff0 `outputs − inputs − offset` fix) |

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

## Output recovery (seed-only)

Grin outputs are created with **grin-standard deterministic rewind nonces**
(`rewind_nonce = BLAKE2b(key = commitment, data = BLAKE2b(public_root_key))`) —
the same view-key scheme `grin-wallet` uses. This makes a wallet **recoverable
from its 12-word seed alone**: re-derive the view key, pull the chain's unspent
outputs with their rangeproofs, and rewind each proof to find and value the
ones that belong to you. The derivation path is read back out of the proof
message, so recovery does not depend on knowing the original derivation depth.

The trade-off is the standard view-key one: anyone holding the wallet's view
key can scan the chain for its outputs (the rangeproof stays zero-knowledge to
everyone else, and the nonce is per-commitment so there is no on-chain
linkage). Treat the Grin view key as sensitive — exactly like a Monero view
key. *(Earlier builds used random per-output nonces, which are not
seed-derivable; those outputs remain spendable but are outside seed-only
recovery.)*

## Test methodology

Two-tier verification before any feature ships:

1. **Mathematical reproducibility** — Rust unit tests with golden vectors computed independently (e.g. via Python's `hmac` module). Any HMAC-SHA512 implementation must produce the same bytes given the same inputs.
2. **Behavioral parity with legacy smirk-extension v0.2.x** — once a feature has Rust unit tests passing, verify it produces the same output as the (frozen) TypeScript/MWC stack for the same inputs. Once parity holds across a representative input set, the new code is safe to ship into the v0.3 monorepo extension.

## WASM exports

Available now in `crates/smirk-wasm/src/grin/` (organized into submodules — `keys`, `schnorr`, `multiparty`, `adaptor`, `bulletproof`, `blind`, `slate`, `slate_builder`, `kernel`, `transaction`, `payment_proof`, `slatepack`):

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
| `grin_slatepack_address_secret(mnemonic, index)` | `hex` — 32-byte ed25519 secret seed for the slatepack address; pairs with `grin_slatepack_address`. Sign payment proofs with this. |
| `grin_sign_payment_proof(amount, kernel_commitment, sender_address, receiver_secret)` | `hex` — 64-byte ed25519 signature attesting receipt of `amount` to `kernel_commitment` from `sender_address` |
| `grin_verify_payment_proof(amount, kernel_commitment, sender_address, receiver_address, signature)` | `bool` — verifies the receiver's ed25519 attestation |
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
| `grin_create_send_transaction(params_json)` | `JSON: { slate_json, sender_context_json, change_output_info_json }` — high-level: picks inputs/change, derives blinds, computes excess + offset, emits S1 |
| `grin_sign_incoming_send_slate(params_json)` | `JSON: { slate_json, receiver_context_json, receiver_output_info_json }` — receiver-side: adds Pedersen output + Bulletproof + partial sig → S2 |
| `grin_finalize_send_slate(params_json)` | `JSON: { slate_json, final_signature_hex, tx_bytes_hex, kernel_excess_hex }` — sender-side: verifies S2 partial, aggregates → S3 + broadcastable TX |
| `grin_create_invoice(params_json)` | `JSON: { slate_json, receiver_context_json, receiver_output_info_json }` — invoice-flow init (I1): receiver picks amount, adds output + partial sig |
| `grin_sign_invoice(params_json)` | `JSON: { slate_json, sender_context_json, change_output_info_json }` — payer's response to invoice (I2): adds inputs, fee, sender partial |
| `grin_finalize_invoice(params_json)` | `JSON: { slate_json, final_signature_hex, tx_bytes_hex, kernel_excess_hex }` — receiver-side I3: aggregate + assemble TX bytes |
| `grin_random_secret_nonce()` | `hex` — fresh 32-byte secp256k1 scalar (mod n); used by callers needing kernel/sig nonces |
| `grin_slate_v4_to_bin_hex(slate_json)` | `hex` — slate v4 compact-binary serialization (`SlatepackBin` payload) |
| `grin_slate_v4_from_bin_hex(bin_hex)` | `string` — inverse: binary back to canonical slate v4 JSON |
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

- `crates/grin-ext/src/seed.rs` — mnemonic → extended private key
- `crates/grin-ext/src/keychain.rs` — BIP32 + switch-commitment-aware blind derivation, cross-validated against `grin_keychain`
- `crates/grin-ext/src/blind.rs` — scalar arithmetic + `sender_blind_excess` (sign convention: `outputs − inputs − offset`)
- `crates/grin-ext/src/slate.rs` — v4 slate JSON types + round-trip
- `crates/grin-ext/src/slate_bin.rs` — v4 compact-binary `SlatepackBin` codec (interop with grin-wallet 5.x)
- `crates/grin-ext/src/slate_builder/` — S1/S2/S3 + I1/I2/I3 ceremony primitives
- `crates/grin-ext/src/wallet_flows.rs` — 6 high-level orchestrators
- `crates/grin-ext/src/kernel.rs` — Plain / Coinbase / HeightLocked / NRD kernels
- `crates/grin-ext/src/slatepack.rs` — armor + binary mode + age encryption
- `crates/grin-ext/tests/grin_wallet_compat.rs` — Layer-2 cross-validation against `grin_wallet_libwallet` 5.4.0 (see `docs/TESTING.md`)
