# Grin

Smirk's Grin / Mimblewimble support is being reimplemented from primitives into `crates/grin-ext/` so we own the protocol layer end-to-end and can extend it with features (atomic-swap adaptor signatures, NRD-kernel time-locks, custom slate workflows) that don't exist in upstream `grin-wallet`.

The legacy [smirk-extension](https://github.com/Such-Software/smirk-extension) v0.2.x ships Grin support via vendored MWC-Wallet WebAssembly, which has been validated against the official `grin-wallet` GUI (a Smirk seed restored in `grin-wallet` recovers the same funds). `crates/grin-ext/` is the production Grin implementation: the v0.3 extension routes every slate ceremony through it, and byte-level parity is held by the cross-validation suite against `grin_wallet_libwallet` (see `crates/grin-ext/tests/README.md`). The v0.3 monorepo (`packages/extension`) is the canonical client going forward; `smirk-extension` is kept frozen as the migration source.

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
| Cross-validation against `grin_wallet_libwallet` 5.4.0 | ✅ Done — `crates/grin-ext/tests/grin_wallet_compat.rs`: 12 tests covering sign convention, `derive_blind` vs `grin_keychain` (5 cases), full S1→S2→S3 round-trip, full I1→I2→I3 round-trip, binary slate round-trip, random secret nonce, `partial_sign` vs `grin_aggsig::sign_single`, depth-3 / depth-4 derivation divergence, `pubkey_to_commitment`, and output identification. Catches protocol-mismatch bugs that internal tests can't (e.g. the c78aff0 `outputs − inputs − offset` fix) |

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

## How a Grin payment travels

The crypto sections above cover how a slate is *built* and *signed*. This section
covers how that slate *moves between two wallets* — the part Grin's interactive
protocol forces on every payment, since sender and receiver must exchange a slate
before a transaction exists.

Smirk is read through a **public-backend / federation lens**: `api.smirk.cash` is
one backend among many, and nothing in the Grin data plane may assume it is the
only one. That single principle sorts every transport and discovery mechanism into
two buckets — **federated** (works across independent backends and self-hosters)
and **same-instance** (a convenience shortcut that only works when both parties
live on the same backend).

### Non-custodial by construction

The backend holds **no Grin balance, no output set, and no transaction history**.
The only Grin state any server persists is the `grin_slatepacks` relay mailbox
(see below), and even that is transient. The server-side Grin surface is just
three stateless proxies to a Grin node / view-wallet:

| Endpoint | Purpose | Stores? |
|---|---|---|
| `POST /wallet/grin/scan {rewind_hash, start_height?}` | View-only rewind scan → `{outputs[], total_balance, last_pmmr_index}` | No |
| `GET  /wallet/grin/height` | Chain tip, for confirmation counting | No |
| `POST /wallet/grin/broadcast {tx}` | Relay a finalized tx to the network | No |

Everything else — **which outputs are yours, their values, their heights, your
balance** — is recomputed from a fresh **rewind scan on every refresh**. The
wallet keeps *no* custodial output store; the scan of the chain's small Grin UTXO
set *is* the wallet state. The only local persistence is a **minimal pending
overlay** (see below) that bridges the few blocks between broadcasting a
transaction and the next scan that reflects it. The backend is a chain-access
relay, not a wallet. Any Grin light-wallet-server exposing these three routes can
back a Smirk wallet, which is exactly what the standalone `grin-lws` service does:
it is the default scan path in production today (see below), with the backend's
direct `grin-wallet` scan as the fallback.

**Balance is derived from a scan, not asked of a server, and not read from a
store.** On every balance refresh the wallet:

1. derives the extended key from the seed and computes a **rewind hash**
   (`rewindHash(extKeyHex)` — a 32-byte view credential; see *Output recovery*);
2. calls `POST /wallet/grin/scan {rewind_hash, start_height}`, which returns the
   wallet's recognized **unspent outputs** — `{commit, value, height, mmr_index,
   is_coinbase, lock_height}` each — computed purely from the view credential. The
   scan stores nothing server-side and is the source of truth for this refresh;
3. fetches the tip (`GET /wallet/grin/height`) to compute maturity;
4. reconciles the pending overlay against the scan (drops entries the scan now
   proves settled), then folds the overlay in to cover the confirmation gap.

Balance is recomputed from the returned `outputs[]`, **not** taken from the
scan's `total_balance` field (which neither subtracts just-spent inputs nor splits
maturity). Per-output maturity: `spendableHeight = is_coinbase ? height + 1440 :
max(height, lock_height)`; an output is *mature* when `tip ≥ spendableHeight`. The
three balance buckets:

- **confirmed** (spendable now) = Σ value of mature outputs whose `commit` is
  **not** in the overlay's pending-spent set;
- **locked** (on-chain, maturing) = Σ value of on-chain-but-immature outputs
  (coinbase inside its 1440-block window, or `tip < lock_height`);
- **pending** (in-flight incoming/change) = Σ value of overlay change/incoming
  entries whose `commit` has **not yet** appeared in `outputs[]` — a scan only
  sees the confirmed UTXO set, so unconfirmed money is overlay-only until mined.

### The pending overlay

The overlay is deliberately **not** an output store, a balance ledger, or
spent-bookkeeping — it exists solely to bridge the window between a broadcast and
the scan that confirms it. It is a small client-only structure (in the extension,
`chrome.storage.local` key `grin_pending_v1`; in `@smirk/core` a pure module over
an injected storage adapter, so core stays platform-agnostic). Keyed by broadcast
slate id, each entry records: the input `commit`s the tx consumes (to **exclude**
from selection until they are mined), the unconfirmed **change** output (to show as
pending), any **incoming** output on the receive side (to show as pending), and a
broadcast timestamp for an age-out backstop. Alongside the entries it carries one
**monotonic `nextChildIndex`** counter.

Clearing is **scan-driven, never optimistic**: an entry is deleted only when the
scan proves its inputs are gone *and* its change has confirmed (a 7-day backstop
sweeps stuck entries so a cancelled/lost slate can't wedge selection). On an
explicit user cancel, its entry is deleted immediately so the inputs become
selectable again.

**Index reuse is money-critical.** With no server output store there is no
server-supplied `next_child_index`; the wallet owns the counter itself, seeded on
load to `max(identified path[2]) + 1` and bumped on every created change/receive
output. Reusing an index re-derives an identical commitment, making the second
output unspendable — so the counter ships together with the path-identification
helper described under *Seed-only recovery*.

### The three transports

A slate is one payload; how it reaches the counterparty is a transport choice.

| Transport | Bucket | When | Discovery key |
|---|---|---|---|
| **Nostr gift-wrap** | **Federated (default)** | Recipient is reachable by Nostr identity | npub / NIP-05 |
| **Manual clipboard** | **Federated (universal)** | No online channel — user copies the armored slatepack | slatepack address (age-encrypts to it) |
| **Backend relay** | **Same-instance** | Both parties on the same backend | backend `user_id` |

- **Nostr gift-wrap** is the federated default. Each slate leg (S1/S2/S3, I1/I2/I3)
  is wrapped in a NIP-59 kind-1059 gift-wrap addressed to the counterparty's npub
  and published to relays. It crosses backends, needs no shared server, and the
  metadata-hiding envelope reveals neither sender, amount, nor slate to relays.
- **Manual clipboard** is the universal fallback — always available, no network
  dependency at all. The wallet armors the slate (`BEGINSLATEPACK…ENDSLATEPACK`),
  age-encrypting it to the recipient's slatepack address when known, and the user
  carries each leg across by copy/paste. Correct for cold, offline, or
  address-only recipients.
- **Backend relay** (`grin_slatepacks` mailbox) is a same-instance convenience: the
  sender POSTs the slatepack keyed by the recipient's backend `user_id`, the
  recipient polls, responds, and the server flips the row's status through its
  lifecycle. It only works when both parties are registered on the *same* backend —
  there is no cross-backend relay federation — so it is strictly a shortcut, never
  a requirement.

### Recipient discovery

How an address in the send box resolves to a transport:

- **npub / NIP-05** → **Nostr gift-wrap** (federated). A NIP-05 handle
  (`user@domain`) is domain-scoped and resolves across backends.
- **backend `user_id`** (via public `GET /users/by-username/{username}`, which
  returns the user's registered Grin and Nostr public keys) → **backend relay**
  when same-instance, else Nostr if the looked-up user exposes an npub.
- **bare slatepack address** (`grin1…`) → **manual clipboard** by default, since a
  raw Grin address carries no routing hint on its own.

**The address → npub bridge.** To let a raw `grin1…` address route automatically
over Nostr, a backend lookup resolves a Grin slatepack address (or Grin public key)
to the owning user's Nostr npub (indexing `user_keys.grin → user → nostr npub`).
When that bridge resolves, a bare-address send is upgraded from clipboard to Nostr
gift-wrap. It is a **same-instance** lookup — it only knows users registered on the
queried backend — so cross-backend bare-address sends stay clipboard until the
sender has the recipient's npub or NIP-05 directly.

Discovery registration is via `POST /api/v1/keys {asset:"grin", public_key}`
(the `user_keys` table), which makes a wallet's Grin address findable by username
on that backend. This is a same-instance directory convenience, not a custodial
binding — the key is published for discovery, not held for spending.

### Seed-only recovery

Because the backend stores no Grin state and the wallet keeps no output store, a
wallet is fully reconstructable from its **12-word seed alone**: re-derive the
extended key, compute the rewind hash, scan. The scan returns the recognized
unspent set and their values, so a fresh re-import immediately *sees* its full
balance with nothing to restore — the scan *is* the recovery. (This subsumes the
old client-side "recover outputs" path entirely; there is no separate recovery
step.)

Restoring the ability to *spend* each recovered output requires its BIP32 path,
which a bare rewind scan does **not** carry (it returns commitments, not proofs or
paths). The default scan path, `grin-lws` (below), closes this gap: its
`get_unspent_outs` recovers each output's `key_id` server-side by rewinding the
rangeproof, so the client parses that verified `key_id` into the spend path and
never has to search. The wallet spends directly from the LWS-provided `key_id`
(see `packages/extension/src/popup/grin-flows.ts`).

The brute-force identify helper remains only as a fallback for the `grin-wallet`
scan path, which returns commitments without a `key_id`. Smirk outputs are
deterministic, so the path is recoverable from the seed: a bounded wasm helper,
**`grin_identify_output(extKey, legacyExtKey, commit, value, maxChild)`**,
searches `n ∈ [0, maxChild]` across the v3/legacy key schemes and the Regular/None
switch-commitment modes, recomputes each Pedersen commitment, and returns the
matching `[0,0,n,0]` path (or null). Input selection prefers the LWS `key_id` and
uses this search only when the scan carried none; either way an output whose path
cannot be resolved is dropped rather than fed to the builder, since a wrong path
silently produces a bad blinding factor.

Legacy pre-HF2 / random-nonce outputs fall outside rewind-scan recognition and
remain proof-recovery-only.

### `grin-lws`: the default scan/spend path

`grin-lws` is a standalone Grin light-wallet-server. It is functional, deployed to
production, and the default path behind `POST /wallet/grin/scan`. It is a **real
light-wallet-server with a DB**, mirroring `monero-lws`: register a `rewind_hash`
(the view credential), run a background chain scanner that stores each account's
outputs *with their recovered paths* and marks spends, and serve `get_balance` /
`get_unspent_outs` / `submit_raw_tx` / `height` fast. Its `get_unspent_outs`
returns outputs **with** a recovered `key_id`, so the client spends directly with
no `grin_identify_output` search. It is a standalone, public-clean, anyone-can-run
service (env-configured, no Smirk-specific detail); the backend proxies it exactly
as it proxies the Monero/Wownero LWS, forwarding only the view-only `rewind_hash`
and storing nothing. Its own repository is public at
[github.com/Such-Software/grin-lws](https://github.com/Such-Software/grin-lws).

The backend still carries the older **stateless on-demand** scan (rewind the whole
UTXO set per request, store nothing, recover no paths) as the fallback: when no
`grin-lws` URL is configured, or a `grin-lws` scan fails, the scan runs against
the authoritative `grin-wallet` view-wallet instead, and the client's
`grin_identify_output` search fills in the paths that path-less response omits.
The `grin_lws` field on `/capabilities` tells the wallet which path a given
instance serves.

### Lifecycle per transport

Grin's two ceremonies each have three legs. The *crypto* of each leg is identical
across transports (see the slate-construction rows in **Status**); only the
*carrier* of each leg and the settlement signalling differ.

**Send (sender-initiated): S1 → S2 → S3**

1. **S1** — sender scans, identifies each mature output's path, selects inputs
   (greedy largest-first with fee iteration) **minus** any commit already in the
   overlay's pending-spent set, and builds the initial slate
   (`createSendTransaction`), which emits a change output at `nextChildIndex`.
   The build atomically reserves `nextChildIndex` and records a not-yet-broadcast
   overlay entry (spent input commits + change), so a concurrent
   send/invoice/receive can neither re-select those inputs nor re-derive the same
   change index while the slate is in flight.
2. **S2** — recipient adds their output + range proof + partial signature
   (`signIncomingSendSlate`) and returns the slate.
3. **S3** — sender finalizes (`finalizeSendSlate`) and broadcasts via
   `POST /wallet/grin/broadcast {tx}`, then flips that overlay entry to broadcast
   and re-anchors its TTL to the real broadcast time. The index is not bumped
   again. The excluded-from-selection guarantee holds until the next scan shows
   the inputs gone. A cancel while still pre-broadcast frees the entry; an
   abandoned one ages out on the 7-day backstop.

Per transport: over **Nostr**, each leg is a gift-wrap, and a successful S3 emits a
`finalizeNotice` settlement gift-wrap so the recipient's inbox item retires by
protocol (not just optimistically); a **cancel** publishes a kind-1059 cancel
gift-wrap and deletes the overlay entry (inputs become selectable again). Over the
**backend relay**, the server flips the mailbox row `pending_recipient →
pending_sender → finalized` and a `settle` call hits relay-finalize after
broadcast; cancel calls the relay cancel endpoint and deletes the overlay entry.
Over **manual clipboard**, the user carries each leg by hand and there is no
settlement signal beyond the on-chain confirmation the next scan observes. All
three route through one `selectSendChannel` / `SlatepackChannel` abstraction —
send, receive, respond, and cancel share the same transport plumbing.

**Invoice (receiver-initiated): I1 → I2 → I3**

1. **I1** — payee reserves `nextChildIndex` for its incoming output and builds an
   invoice slate naming the amount (`createInvoice`). No overlay entry is recorded
   yet: nobody has committed to pay, so counting the amount would inflate the
   pending balance on speculation.
2. **I2** — payer scans, identifies + selects inputs (minus pending-spent) and adds
   inputs, fee, and their partial signature (`signInvoice`), recording its own
   pending entry (spent inputs + change) at build time.
3. **I3** — payee finalizes (`finalizeInvoice`) and broadcasts, then records its
   incoming output in the overlay. The index was already reserved at I1.

The same three transports carry the invoice legs. On the receive side generally
(incoming send or invoice), an `incoming` overlay entry makes the received amount
show as *pending* until a scan confirms it. The invoice payee records it when it
broadcasts I3; a wallet signing an incoming S1 records it as it signs, since there
the sender does the broadcasting. Either way the index is reserved before the
output is built, so a receive index is never reused. Cancelling clears the
relevant overlay entry.

**Money-critical invariants (all transports):**

- **Exclude-until-mined.** An input a slate consumes is added to the
  pending-spent set when the slate is *built* and excluded from selection until a
  scan proves it gone — preventing an accidental double-spend of the same UTXO in
  the confirmation gap. Reserving at build rather than at broadcast also closes
  the window where a concurrent flow re-selects the same UTXO while the first
  slate is still in flight. A pre-broadcast cancel frees it immediately; the
  7-day backstop frees an abandoned one. This is enforced identically whether the
  carrier is Nostr, relay, or clipboard.
- **No index reuse.** `nextChildIndex` is monotonic and bumped on every created
  change/receive output; reusing it would re-derive an identical, unspendable
  commitment.

## Test methodology

Two-tier verification before any feature ships:

1. **Mathematical reproducibility** — Rust unit tests with golden vectors computed independently (e.g. via Python's `hmac` module). Any HMAC-SHA512 implementation must produce the same bytes given the same inputs.
2. **Protocol parity with the official reference** — cross-validate every load-bearing primitive against `grin_wallet_libwallet` in `crates/grin-ext/tests/grin_wallet_compat.rs`. Internal tests cannot catch a convention that is self-consistent but wrong on the wire; the reference parser and kernel-excess derivation can.

## WASM exports

Available now in `crates/smirk-wasm/src/grin/` (organized into submodules — `keys`, `schnorr`, `multiparty`, `adaptor`, `bulletproof`, `blind`, `slate`, `slate_builder`, `kernel`, `transaction`, `payment_proof`, `slatepack`, `wallet_flows`, `voucher`):

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
| `grin_sender_blind_excess(input_blinds, sender_output_blinds, kernel_offset)` | `hex` — Σoutputs − Σinputs − offset |
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
| `grin_create_grin_voucher(params_json)` | `JSON: { voucher, change?, kernel_excess_hex, tx_bytes_hex, tx_json }` — sender-side single-party tx placing a voucher UTXO on chain (non-interactive transfer, used by social tipping); returns the voucher's blinding factor for the JS layer to encrypt to the recipient |
| `grin_sweep_grin_voucher(params_json)` | `JSON: { output, kernel_excess_hex, tx_bytes_hex, tx_json }` — claimer-side: given the decrypted blinding factor, sweeps the voucher UTXO into a new output the claimer controls |
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
