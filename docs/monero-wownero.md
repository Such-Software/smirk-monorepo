# Monero + Wownero

Smirk supports both Monero (XMR) and Wownero (WOW) through a single Rust + WASM stack.

## Crates

- **`crates/monero-oxide/`** — vendored fork of [monero-oxide](https://github.com/monero-oxide/monero-oxide) with Wownero transaction support added in-tree. 16 library sub-crates covering ed25519, ringct (CLSAG, MLSAG, Borromean, Bulletproofs+), wallet logic, address parsing, and protocol types (18 counting the two test crates under `crates/monero-oxide/tests/`; all of them are workspace members, listed at `Cargo.toml:6-28`).
- **`crates/smirk-wasm/`** — wasm-bindgen wrapper. Exposes the Monero/Wownero functions to JavaScript as a single WASM bundle.

## Status

**Working in production.** The legacy [smirk-extension](https://github.com/Such-Software/smirk-extension) v0.2.x ships this stack today; the v0.3 monorepo (`packages/extension`) consumes the same `crates/smirk-wasm` bundle (now `--target no-modules` per `ARCHITECTURE.md`). Wallet creation, balance display, key image computation, transaction signing, and broadcast are all live. Every transaction is signed with a fresh `outgoing_view_key` drawn from `OsRng`, so the OVK cannot link transactions across sends (`crates/smirk-wasm/src/signing.rs`).

## Wownero differences from Monero

Three protocol-level differences are handled in `crates/monero-oxide/`:

| Difference | Monero | Wownero |
|---|---|---|
| RCT type | `ClsagBulletproofPlus` (type 6) | `WowneroClsagBulletproofPlus` (type 8) |
| Ring size | 16 (15 decoys + 1 real) | 22 (21 decoys + 1 real) |
| Output commitment scaling | Stored as `C` | Stored as `C/8`, recovered via `scalarmult8(outPk)` |

The `RctType` enum carries both variants; the consumer picks at runtime via the `coin: "xmr" | "wow"` field on transaction params.

## Subaddresses

Derivation lives in `packages/core/src/address.ts` and mirrors Monero's `get_subaddress`:

```
m = Hs("SubAddr\0" || a || major_LE || minor_LE)   // Hs = keccak256 mod l
D = B + m·G                                        // subaddress public spend key
C = a·D                                            // subaddress public view key
address = base58(subaddressPrefix || D || C || checksum)
```

`a` is the private view key and `B` the public spend key. The subaddress prefix is 42 for XMR and 12208 for WOW. `(0, 0)` is the PRIMARY address, not a subaddress: passing it throws, so a caller cannot hand out the primary address as if it were fresh.

**Spending a subaddress output is not flag-gated.** An LWS unspent output carries an optional `subaddr_index`, and that index must reach the signer verbatim:

- It is folded into the key offset, so the recovered one-time key controls the output. Signing refuses to proceed when the derived key does not match, rather than producing a transaction the network rejects.
- `derive_output_key_image` and `compute_key_image` both take optional `subaddr_major` / `subaddr_minor`. Absent (or `(0, 0)`) means the primary address and the payload is byte-identical to the pre-subaddress one. Supplying only one of the two is an error, not a fallback to the primary address.

A client that builds an LWS payload and drops `subaddr_index` strands every output received on a subaddress: its key image will not match, and the funds are unspendable through that path.

**Handing out fresh receive subaddresses IS gated**, behind the `ENABLE_SUBADDRESS_RECEIVE` client flag (default off, `packages/extension/src/popup/receive-subaddress-index.ts`).

## WASM API

Exported by `crates/smirk-wasm/`:

| Function | Purpose |
|---|---|
| `validate_address(addr)` | Parse + validate Monero or Wownero address; auto-detects which based on prefix |
| `parse_tx(hex)` | Decode tx hex → JSON |
| `derive_key_image(...)` | Compute key image from view key + tx_pub_key + index |
| `derive_output_key_image(...)` | Same, but for a specific known output_key |
| `compute_key_image(...)` | Compute from wallet keys + tx_pub_key (no output_key needed) |
| `estimate_fee(...)` | Compute fee for a tx given inputs and per-byte fee |
| `sign_transaction(...)` | Build + sign transaction client-side, return signed tx hex |

All functions return JSON for ergonomic consumption from TypeScript.

## Why a fork instead of upstream contribution

The Wownero changes (RCT type 8, ring 22, commitment scaling) sit deep in the transaction construction path and don't feature-flag cleanly without upstream API changes the upstream maintainers haven't adopted. The fork is small (~1 commit of protocol changes) and the upstream-merge workflow is straightforward: because the Wownero deltas are isolated to a single commit on the transaction-construction path, rebasing onto a newer upstream (including the eventual fcmp++ migration) stays a contained operation.

## Publishing

The standalone fork at [Such-Software/monero-oxide](https://github.com/Such-Software/monero-oxide) publishes the workspace crates to crates.io under the `wownero-*` namespace (`wownero-oxide`, `wownero-ed25519`, `wownero-clsag`, etc.). Library names stay as `monero_*` so existing Rust code does `use monero_oxide::...` unchanged.

Sync the standalone fork from the monorepo via `git subtree push` — see [MONOREPO.md](../MONOREPO.md#pushing-back-to-the-standalone-monero-oxide-fork-for-cratesio-publish).
