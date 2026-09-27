# Legacy key recovery utility

> Status: stable · Updated 2026-09-27 · Applies to: manual recovery from legacy Smirk derivations

`scripts/seed-to-keys/seed-to-keys.mjs` derives the primary addresses and
private keys for Smirk derivation versions 1, 2 and 3 from a 12-word BIP39
phrase. It is a low-level recovery utility, not a wallet scanner. It does not
query balances, discover every fresh address or perform a transfer.

## Choose the recovery path

Use the wallet's migration flow first. Legacy BTC/LTC funds may use the
`m/44'/coin'/0'/0/0` path with P2WPKH encoding; v0.3 uses the BIP84 account
`m/84'/coin'/0'`. A BIP39 import must select the matching derivation path,
coin and address type. Support for BIP39 alone does not establish compatibility.

For an external recovery, verify the derived public address against the known
receiving address. Registration date alone does not identify the derivation
that holds funds. The script prints hex private keys, not WIF or a complete
wallet export; the target wallet must support the relevant format and address
type. Do not paste a hex key into an unrelated import field.

The version 3 XMR/WOW derivation uses the Cake-compatible BIP39 path. Legacy
versions derive different keys. The Grin output includes the slatepack key;
that key alone is not a complete spend-wallet export. See the derivation and
restore requirements in [Send flow](../../docs/SEND_FLOW.md) and
[Grin](../../docs/grin.md).

## Execution boundary

The current utility reads from standard input and prints private keys to
standard output. Interactive input is visible. It is unsuitable for an agent
session, CI, support logs, recorded terminals or automated demo capture. No
recovery phrase or private output belongs in a command line, report or chat.
Clearing scrollback does not establish deletion from logs or recordings.

Only the wallet owner should perform a manual recovery in a trusted offline
environment that they control. A support investigation uses public addresses
and transaction IDs; it does not require the user's recovery phrase.

The source imports the built `@smirk/core` package. Its non-secret build
prerequisites are:

```bash
npm ci
npm run build -w @smirk/assets -w @smirk/core
```

No production recovery was performed as part of this documentation review.
A browser recovery interface is not implemented.

## Recovery checklist

- [ ] Prefer the supported migration flow before manual key recovery.
- [ ] Match the public address and derivation, rather than inferring from dates.
- [ ] Confirm the target wallet's coin, path and import format.
- [ ] Keep all secret input and output outside agents, logs and recordings.
- [ ] Verify actual recovery in the target wallet; deriving a key proves no balance.
