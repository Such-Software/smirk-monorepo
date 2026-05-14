# Testing strategy

Three layers, each catching a different class of bugs. Each layer requires
the previous one to be green before it's worth running.

```
                    Layer 3 — End-to-end
                  ┌──────────────────────┐
                  │  Production extension │
                  │  + mobile + backend   │
                  │  vs grin-wallet GUI   │
                  └──────────────────────┘
                          ▲
                Layer 2 — Cross-implementation interop
              ┌────────────────────────────────────────┐
              │  Our WASM ↔ grin-wallet via fixtures   │
              │  Our WASM ↔ Grin testnet via broadcast │
              └────────────────────────────────────────┘
                          ▲
                Layer 1 — Unit tests + WASM smoke
              ┌────────────────────────────────────────┐
              │  cargo test --workspace                │
              │  Node smoke harness against every      │
              │  WASM export                           │
              └────────────────────────────────────────┘
```

## Layer 1: unit tests + WASM smoke (every commit)

**Status: active.** Runs in CI on every push.

### Rust unit tests

`make rust-test` runs `cargo test --workspace`. Each crate has its own
test module per file. Current state (as of 2026-05-13):

| Crate | Test count | Coverage focus |
|---|---|---|
| `crates/monero-oxide/` | upstream tests + Smirk additions | RctType variants (incl. Wownero), address codecs, ringct ops |
| `crates/grin-ext/` (unit) | 130 | seed derivation, bip32, secp256k1, switch-commitment blind derivation, slatepack address, Schnorr (single + multi-party + adaptor), slate v4 (JSON + binary), Pedersen, Bulletproofs, kernels (incl. NRD), slatepack codec (armor + bin + age encryption), 6 wallet orchestrators, payment proofs |
| `crates/grin-ext/` (integration) | 8 | cross-validation against `grin_wallet_libwallet` 5.4.0 — see Layer 2 below |
| `crates/btc-ext/` | active | BIP84/BIP86 derivation, PSBT build + sign + extract, fee estimation |
| `crates/secp256k1zkp/` | upstream tests | covered via `cargo test`; mostly the C lib's own self-tests |
| `crates/smirk-wasm/` | 10 | exposed Monero/Wownero/Grin functions |
| `crates/swap-core/` | 1 | placeholder |

**Conventions per module:**
- Round-trip tests for every (encode, decode) pair
- Golden vectors for any deterministic crypto operation, with **independent
  verification source documented in the test** (e.g. python `hmac`, Node
  `crypto`, real grin-wallet output committed to source as fixture)
- Adversarial tests: rejection of wrong inputs (wrong nonce, wrong message,
  tampered signature, mismatched checksum, ...)
- Real upstream fixtures wherever available (e.g. `slatepack` module
  decodes a fixture from `grin-wallet/api/src/owner_rpc.rs` doc-tests)

### WASM runtime smoke

`scripts/wasm-smoke.mjs` loads the Node-target WASM build
(`crates/smirk-wasm/pkg-node/`) and exercises a representative subset
of every exported function. Catches a class of bugs that native unit
tests miss:
- wasm-bindgen typing mismatches between Rust and TS
- WASM build pipeline regressions (wrong wasm-bindgen-cli version,
  missing exports, etc.)
- `target_arch = "wasm32"` cfg gates that compile but don't actually
  function

Runs via `make wasm-smoke` (which builds the Node-target bundle first).

**Known smoke limitations (Node only — browser is unaffected):**
- Pedersen commit + Bulletproof create/verify call into
  `libsecp256k1-zkp`'s `malloc` path, which Node's `--target nodejs`
  WASM loader can't satisfy (eager import resolution; no host malloc
  in Node's WebAssembly env). The browser's `--target no-modules`
  build (active since 2026-05-11) ships an `env`-stub postprocess
  (`crates/smirk-wasm/postprocess.mjs`) that satisfies these imports
  at instantiate time, but the Node target uses a different glue
  format that bypasses the postprocess. Native unit tests in
  `crates/grin-ext/src/bulletproof.rs::tests` cover them.
- A future browser-based harness (puppeteer / playwright) would close
  this gap; not built yet.

## Layer 2: cross-implementation interop (per release candidate)

**Status: active for Grin; planned for other chains.** The
grin-ext crate runs the official `grin_wallet_libwallet` 5.4.0 +
`grin_keychain` 5.3.3 as **dev-dependencies** and cross-validates
load-bearing primitives + full ceremony round-trips against them. This
catches a class of bug that internal tests can't: a sign convention or
serialization choice that's internally consistent but doesn't match
what the network actually requires.

See `crates/grin-ext/tests/README.md` for the strategy doc. Real
example caught: c78aff0 — `sender_blind_excess` returned
`inputs − outputs − offset` (wrong by sign), all 100+ internal tests
passed because both sides used the same wrong convention, but a real
mainnet broadcast would have failed at kernel verification.

### Grin cross-validation tests (8 today)

`crates/grin-ext/tests/grin_wallet_compat.rs`:

1. `sender_blind_excess` sign convention matches `grin_wallet_libwallet`
2-6. `derive_blind` byte-equivalent with `grin_keychain::ExtKeychain::derive_key`
   across 5 cases (different paths, both switch types)
7. Full S1→S2→S3 round-trip: our slate fed through the reference's
   verifier produces a valid aggregate signature against the kernel
   commitment derived from the on-chain outputs/inputs
8. Full I1→I2→I3 round-trip: same, inverse direction
   Plus binary slate round-trip (`SlatepackBin` codec ↔ reference's `v4_bin`)
   and `random_secret_nonce` distribution sanity check.

Dev-deps don't ship in the production WASM bundle — `grin_wallet_libwallet`
is a `[dev-dependencies]` entry, used by `cargo test` only.

### Upstream fixtures (committed, expand as bugs are found)

We also commit real-world output from `grin-wallet` / Grim:

- `crates/grin-ext/src/slatepack.rs::FIXTURE` — real slatepack from
  `grin-wallet/api/src/owner_rpc.rs`, verified to dearmor + parse +
  re-encode losslessly through our types
- `crates/grin-ext/src/slate.rs::FIXTURE_I2` — real slate v4 JSON,
  verified to round-trip through SlateV4 types

**To add for other chains:**
- BTC: a real PSBT from Sparrow / Bitcoin Core, verified to round-trip
- XMR: a real signed tx from monero-wallet-cli, verified to parse

### Grin testnet (planned, not yet built)

Once slate construction lands, the test infrastructure to add:

- A long-running Grin testnet node + grin-wallet instance, configured
  with a known seed
- A Smirk wallet built from this monorepo, configured with the same
  seed (for cross-verify) or a separate seed
- A test runner (probably `tests/grin-testnet/`) that:
  - Sends Grin testnet from grin-wallet → Smirk, verifies receipt
  - Sends Grin testnet from Smirk → grin-wallet, verifies broadcast
    + confirmation
  - Generates an encrypted slatepack on each side, verifies the other
    side decrypts
  - Runs once per release candidate, NOT on every commit (network
    latency + node sync time make this too slow for CI)

### Manual fixture cross-check

For features where automated cross-impl testing is infeasible (e.g. UI
flows in grin-wallet GUI), we keep a small `docs/MANUAL_TESTS.md`
with reproducible steps + expected outcomes. Updated when bugs are
found, run by hand before each release.

Currently captured: the slatepack address derivation manually verified
against Grim GUI for the standard zero-entropy BIP39 mnemonic.

## Layer 3: end-to-end test matrix (pre-release)

**Status: planned, requires the TS migration + production extension.**

Once the TypeScript packages are populated and the existing
smirk-extension is migrated into `packages/extension/`, the matrix
to run before each public release:

### Per-asset send / receive

For each of `BTC | LTC | XMR | WOW | GRIN`:
- [ ] Wallet creation: 12-word mnemonic generated; restore from same
      mnemonic produces same addresses
- [ ] Receive: external sender funds an address; UI shows confirmed balance
- [ ] Send: spend to an external address; tx confirms on-chain
- [ ] Send to another Smirk user (social tip flow): pending → confirmed →
      claimed
- [ ] Migration / sweep of v1 / v2 wallet addresses (existing tech debt)

### Grin-specific

- [ ] Sync slatepack send: copy-paste flow with another Smirk wallet
- [ ] Sync slatepack send: copy-paste flow with grin-wallet GUI (Grim)
- [ ] Async (encrypted) slatepack send to a known recipient address
- [ ] Slatepack address shown in UI matches Grim for the same seed
- [ ] (When live) Atomic swap with another Smirk wallet on testnet
- [ ] (When live) Atomic swap with native BTC wallet on testnet

### dApp connect flow

- [ ] `window.smirk.connect(['xmr'])` returns only the requested asset's keys
- [ ] Approval popup shows raw origin URL, not page-spoofable favicon
- [ ] Per-origin approval persists across browser restarts

### Cross-platform

- [ ] Chrome MV3 build: install + run + send + receive
- [ ] Firefox build: install + run + send + receive
- [ ] Capacitor Android build: same matrix
- [ ] Capacitor iOS build: same matrix

### Migration paths

- [ ] Existing smirk-extension v0.2.x user upgrading: balances correct,
      seed unchanged
- [ ] Existing user with private LWS mode (v0.3+): self-hosted LWS still
      reachable, scans complete

## What we explicitly DON'T test

- **Mock servers with hand-crafted responses.** We've been burned by this
  pattern: mocks pass while real backend changes break prod. Integration
  tests hit a real backend (test instance) or are skipped.
- **Mocked-out crypto.** Crypto round-trips against the real implementation
  always — never a stub that "pretends to verify."

## Adding tests

When you add a public function, add at least:
1. One round-trip test (if applicable)
2. One golden-vector test if the function is deterministic, with the
   golden value computed independently and the source documented in a
   comment
3. One adversarial test that the function rejects malformed / wrong inputs

If the function is exposed to JS via `crates/smirk-wasm/`, add a smoke
call to `scripts/wasm-smoke.mjs` so the export is validated end-to-end
through wasm-bindgen.
