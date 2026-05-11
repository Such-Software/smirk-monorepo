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
test module per file. Current state (as of 2026-05-08):

| Crate | Test count | Coverage focus |
|---|---|---|
| `crates/monero-oxide/` | upstream tests + Smirk additions | RctType variants, address codecs, ringct ops |
| `crates/grin-ext/` | 61 | seed derivation, bip32, secp256k1, slatepack address, Schnorr (single + multi-party), slate v4, Pedersen, Bulletproofs, slatepack codec (armor + bin + age encryption) |
| `crates/secp256k1zkp/` | upstream tests | covered via `cargo test`; mostly the C lib's own self-tests |
| `crates/smirk-wasm/` | 9 | exposed Monero/Wownero functions |
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

**Status: planned, partial today.** Needs more upstream fixtures and a
Grin testnet test infra.

### Upstream fixtures (today, expand as bugs are found)

We commit real-world output from `grin-wallet` / Grim and verify our
crate reproduces or accepts it byte-for-byte:

- `crates/grin-ext/src/slatepack.rs::FIXTURE` — real slatepack from
  `grin-wallet/api/src/owner_rpc.rs`, verified to dearmor + parse +
  re-encode losslessly through our types
- `crates/grin-ext/src/slate.rs::FIXTURE_I2` — real slate v4 JSON,
  verified to round-trip through SlateV4 types

**To add (when relevant work is done):**
- A real `bullet_proof` produced by grin-wallet, verified by our wrapper
- A real Schnorr signature from grin-wallet, verified by our `verify`
  (validates wire-format byte equivalence)
- A complete signed slate v4 from grin-wallet, end-to-end through our
  parser + signature verifier

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
