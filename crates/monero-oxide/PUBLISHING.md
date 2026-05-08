# Publishing to crates.io as `wownero-*`

This is a fork of [monero-oxide](https://github.com/monero-oxide/monero-oxide) that adds Wownero transaction support. We publish to crates.io under the `wownero-*` namespace so external projects can depend on it without git dependencies.

## Why a Fork?

Wownero uses a different RCT type (type 8 vs Monero's type 6), a larger ring size (22 vs 16), and different commitment scaling. These changes are minimal (~1 commit) but fundamental to transaction construction and can't be contributed upstream as a feature flag without significant refactoring of the monero-oxide API.

## The Rename Strategy

The upstream crate names (`monero-oxide`, `monero-io`, etc.) are already registered on crates.io by the original author. We rename the **package names** to `wownero-*` but keep the **library names** as `monero_*`:

```toml
[package]
name = "wownero-oxide"     # What crates.io and `cargo add` see

[lib]
name = "monero_oxide"       # What `use monero_oxide::...` in Rust sees
```

This means:
- `cargo add wownero-oxide` works for external consumers
- **Zero changes to `.rs` source files** — all `use monero_io::...`, `use monero_oxide::...` imports remain unchanged
- Only `Cargo.toml` files are modified (package names and dependency references)
- Merging upstream changes only conflicts in Cargo.toml files, never in Rust source

## Crate Mapping

| Upstream Name | Published Name | Lib Name (unchanged) |
|---|---|---|
| monero-io | wownero-io | monero_io |
| monero-primitives | wownero-primitives | monero_primitives |
| monero-ed25519 | wownero-ed25519 | monero_ed25519 |
| monero-mlsag | wownero-mlsag | monero_mlsag |
| monero-clsag | wownero-clsag | monero_clsag |
| monero-borromean | wownero-borromean | monero_borromean |
| monero-bulletproofs-generators | wownero-bulletproofs-generators | monero_bulletproofs_generators |
| monero-bulletproofs | wownero-bulletproofs | monero_bulletproofs |
| monero-oxide | wownero-oxide | monero_oxide |
| monero-base58 | wownero-base58 | monero_base58 |
| monero-address | wownero-address | monero_address |
| monero-epee | wownero-epee | monero_epee |
| monero-interface | wownero-interface | monero_interface |
| monero-daemon-rpc | wownero-daemon-rpc | monero_daemon_rpc |
| monero-simple-request-rpc | wownero-simple-request-rpc | monero_simple_request_rpc |
| monero-wallet | wownero-wallet | monero_wallet |

## Publish Order

Crates must be published in dependency order (leaves first). Wait a few seconds between publishes for crates.io to index.

```bash
# Level 0: No internal dependencies
cargo publish -p wownero-io
cargo publish -p wownero-primitives
cargo publish -p wownero-epee

# Level 1: Depends on level 0
cargo publish -p wownero-ed25519          # depends on wownero-io
cargo publish -p wownero-base58           # depends on wownero-primitives

# Level 2: Depends on levels 0-1
cargo publish -p wownero-mlsag            # depends on wownero-io, wownero-ed25519
cargo publish -p wownero-clsag            # depends on wownero-io, wownero-ed25519
cargo publish -p wownero-borromean        # depends on wownero-io, wownero-ed25519
cargo publish -p wownero-bulletproofs-generators  # depends on wownero-io, wownero-ed25519, wownero-primitives
cargo publish -p wownero-address          # depends on wownero-io, wownero-ed25519, wownero-primitives, wownero-base58

# Level 3: Depends on levels 0-2
cargo publish -p wownero-bulletproofs     # depends on wownero-bulletproofs-generators + level 0-1
cargo publish -p wownero-oxide            # depends on all ringct crates + level 0-1

# Level 4: Depends on wownero-oxide
cargo publish -p wownero-interface        # depends on wownero-oxide
cargo publish -p wownero-daemon-rpc       # depends on wownero-oxide, wownero-address, wownero-interface, wownero-epee

# Level 5: Depends on level 4
cargo publish -p wownero-simple-request-rpc  # depends on wownero-daemon-rpc
cargo publish -p wownero-wallet           # depends on wownero-oxide, wownero-clsag, wownero-interface, wownero-address
```

## How to Publish a New Version

1. Merge any upstream changes: `git fetch upstream && git merge upstream/main`
2. Resolve Cargo.toml conflicts (package names and dependency names — the only differences from upstream)
3. Bump version numbers as needed
4. Dry run: `cargo publish -p wownero-oxide --dry-run`
5. Publish in the order above

## How to Merge Upstream Changes

```bash
git fetch upstream
git merge upstream/main
```

Conflicts will only appear in `Cargo.toml` files (the rename lines). The resolution is always: keep the `wownero-*` package names and dependency references, take upstream's version numbers and any new dependencies.

No `.rs` files will conflict because we preserved the original `monero_*` library names.

## For External Consumers

Add to your `Cargo.toml`:

```toml
[dependencies]
wownero-oxide = "0.1"

# Or for wallet functionality:
wownero-wallet = "0.1"
```

In your Rust code, use the original `monero_*` import names:

```rust
use monero_oxide::transaction::Transaction;
use monero_wallet::send;
```

This works because the `[lib] name` is preserved as `monero_*`.

## What Changed from Upstream

Single commit: **"feat: add Wownero RCT type 8 transaction support"**

- `RctType::WowneroClsagBulletproofPlus` variant (serializes as type 8 on wire)
- `RctPrunable::Clsag` carries explicit `rct_type` field for correct serialization
- OutPk commitments scaled by `INV_EIGHT` before signing for Wownero
- Ring size 22 (21 decoys) support for Wownero vs Monero's 16

Files modified: `src/ringct.rs`, `wallet/src/send/mod.rs`, `wallet/src/send/tx.rs`
