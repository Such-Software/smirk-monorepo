# swap-core

> Status: experimental · Updated 2026-10-10 · Applies to: Smirk client source

`swap-core` contains an offline BasicSwap message compatibility prototype. The
`basicswap-interop` Cargo feature is disabled by default. There are no wallet UI
entry points, WASM bindings, relay connections, transaction constructors or
settlement operations.

## Implemented scope

The reference is [BasicSwap v0.19.0](https://github.com/basicswap/basicswap/tree/277b46b0278f1cc76199f7e847988647a1b36e38),
commit `277b46b0278f1cc76199f7e847988647a1b36e38`, distributed under the MIT license.
Compatibility is limited to its Nostr transport and uncompressed SMSG payload
format 2.

| Component | Behavior |
| --- | --- |
| Nostr envelope | Verify kind 4859, `bsx` tag, canonical event ID, BIP340 signature and expiration |
| SMSG envelope | Verify bounds, ECDH-derived HMAC, AES-256-CBC padding, payload length and recoverable ECDSA sender signature |
| Message codec | Decode and canonically re-encode offers, offer revocations and Nostr connection requests/ACKs |
| Advertisements | Recognize BTC/LTC/XMR/WOW identifiers, supported protocol versions, nonzero amounts and basic lifetime/lock declarations |
| Observation cache | Bound storage, deduplicate SMSG identifiers, retain early revocations, reject clock rollback and refuse capacity exhaustion |
| Route checks | Bind the announced key to the Nostr signature, SMSG sender, address namespace, offer and pending request; reject stale key replacement |

The codec preserves integer atomic amounts. It does not qualify chain-specific
amount limits, fee rates, funding scripts, output maturity, refund deadlines or
counterparty inventory. The raw codec retains all known offer fields; the typed
advertisement exposes only the inspected subset. Grin, ETH, two-scriptless-asset
pairs and settlement messages are outside this prototype.

The receiver takes a dedicated messaging key supplied by its caller. It derives
no wallet or social identity keys and opens no Particl RPC connection. The Nostr
author and SMSG sender are separate identities. Public offer relay signatures do
not have to use the offer sender's key; direct-route announcements must use their
announced route key.

## Authentication and recovery boundaries

SMSG's sender signature authenticates the payload, not the envelope timestamp or
recipient. Its MAC covers the timestamp, IV and ciphertext. Because public offer
discovery uses a shared recipient key, an advertisement's envelope lifetime is
not independent proof of fresh maker consent. Rewrapping an old signed payload
can produce a different SMSG identifier. Deduplication and revocation here apply
to the original identifier, not every possible re-encryption of its payload.
A fresh authenticated negotiation and a fully validated transaction graph remain
necessary before funding.

The observation cache and route objects are in memory. No retry scheduler,
encrypted recovery store, multi-tab ownership or restart restoration is provided.
A cache-capacity refusal must stop admission; it must not be treated as an empty
or healthy book. Route expiration is scoped to this fundless handshake model,
not to the lifetime of funded recovery obligations.

Parsing deliberately rejects duplicate fields, nonminimal or overflowing
varints, unknown message fields, non-boolean values, malformed UTF-8, truncated
length-delimited values and ambiguous connection data. It requires one expiration
tag matching the SMSG lifetime, rejects timestamps over ten minutes ahead of the
supplied clock, and limits offers to 48 hours. The Python reference accepts some
noncanonical inputs that this implementation refuses. Compression, legacy SMSG
payload format 1, paid messages, message PoW enforcement and SimpleX transport
are not implemented. Transport-level rate limiting remains a prerequisite for
any network adapter.

## Verification

Run the native and browser-target checks from the repository root:

```sh
cargo test --locked -p swap-core --features basicswap-interop --all-targets
cargo clippy --locked -p swap-core --features basicswap-interop --all-targets --no-deps -- -D warnings
cargo check --locked -p swap-core --features basicswap-interop --target wasm32-unknown-unknown
cargo build --locked -p swap-core --features basicswap-interop --example basicswap_fixture
```

The differential runner requires Python 3.11 through 3.13, the pinned dependencies in
`crates/swap-core/tests/reference-requirements.txt`, and a clean BasicSwap checkout
at the reference commit:

```sh
PYTHONDONTWRITEBYTECODE=1 python crates/swap-core/tests/basicswap_reference.py \
  --reference /path/to/basicswap --binary target/debug/examples/basicswap_fixture
```

The runner uses BasicSwap's actual message serializer, SMSG encryption/decryption
and Nostr signing functions. Rust-decoded identifiers, sender keys and canonical
message bytes must agree; Rust re-encodings are decoded again by BasicSwap. The
reference connection-request constructor and ACK handler run unchanged with
in-memory send/database adapters. Negative
cases exercise altered signatures, recipient keys, payload lengths, MACs,
padding, expirations, offer bindings and replayed ACKs. Keys are random, unfunded
and process-local; they pass to the fixture executable over stdin and are never
written to fixtures or logs. No wallet daemon, relay or funded swap is involved.
CI runs this lane explicitly while the wallet feature remains disabled.

## Settlement prerequisites

1. Add an outbound codec and isolated peer-session test, then encrypted durable
   session state, bounded retries, duplicate delivery and restart tests. Keep
   messaging, per-route signing and wallet spending keys separate.
2. Specify the complete WOW/LTC transaction graph against the pinned BasicSwap
   adaptor protocol, including both commercial directions, key-release proofs,
   refund/compensation paths and split-proof message binding. Verify current
   consensus acceptance in an isolated network before wallet activation.
3. Persist single-use multiparty nonce consumption before producing any signing
   response. Prevent reuse across retries, tabs and restored backups. Existing
   Grin signing helpers do not provide this orchestration guarantee.
4. Qualify Grin separately with current absolute-height kernels and preauthorized
   recovery transactions. NRD serialization does not establish mainnet support.
   Grin aggsig and Bitcoin Schnorr are distinct signature schemes despite sharing
   secp256k1. The ignored Grin adaptor round-trip requires resolution and reference
   verification before it can support funded swaps.
5. Add client-side chain observation, fee adjustment, reorganization handling,
   privacy-chain scanning and recovery sweeps. Ordinary wallet balance responses
   are insufficient evidence of a correctly funded swap.

No consensus change, trusted setup or legacy XMR/WOW `unlock_time` is required
for this message compatibility work. These checks establish a bounded codec and
handshake subset, not a completed BasicSwap peer or an atomic-swap implementation.

## Maintenance checklist

- [x] Implemented behavior is separated from settlement prerequisites.
- [x] Reference revision and reproducible checks are identified.
- [x] Parsing, authentication, capacity and recovery limits are explicit.
- [x] New wallet functionality remains disabled.
- [x] Documentation contains no credential values or private operational evidence.
