# seed-to-keys

Standalone recovery tool for users on legacy Smirk derivations (v1, v2)
who want to import their funds into a non-Smirk wallet.

## What it does

Takes a 12-word BIP39 mnemonic and prints:

- BTC + LTC: hex private keys + bech32 addresses at all three derivation
  generations (v1/v2 share a Smirk-specific path; v3 is standard BIP84:
  see "BTC/LTC: pre-v0.3 wallets need the hex private key" below)
- XMR + WOW: private spend key, private view key, public address, at
  all three derivation generations (v1, v2, v3)
- Grin: slatepack address + private key, at all three generations

## BTC/LTC: pre-v0.3 wallets need the hex private key (not the seed)

Smirk shipped its alpha-period BTC/LTC derivation at the BIP44 path
`m/44'/coin'/0'/0/0` with P2WPKH bech32 encoding — a Smirk-specific
combination that no standard wallet reproduces from a seed import.
**v0.3 (2026-05-11) switches BTC/LTC to standard BIP84** (`m/84'`),
so future Smirk-created wallets work with any standard wallet's
seed-phrase import.

The script prints **all three derivation versions** for BTC/LTC.
Match yours by registration date:

- **Registered in v0.3 or later** → your funds are at the **v3**
  address. Any standard wallet (Sparrow, Electrum, Cake, Bitcoin Core)
  will see them by importing the seed phrase.
- **Registered before v0.3** → your BTC/LTC funds are at the **v1/v2**
  address (both rows show the same Smirk-specific address). Sparrow /
  Electrum / Cake **won't see them from a seed import** — they derive
  at standard BIP84 and check the wrong address. Import the **hex
  private key** directly into:
  - **Sparrow:** New Wallet → "Software Wallet" → "Imported Hex" / WIF
  - **Bitcoin Core:** `importprivkey "<wif>"` (rescan needed)
  - **Electrum:** New wallet → "Use a master key" → paste WIF

XMR/WOW *are* Cake-compatible (verified) — seed-phrase import to
Cake works for those. Grin is grin-wallet/Grim compatible via seed.

The user can then import the relevant keys into a target wallet:
- **Cake Wallet** for XMR/WOW ("Restore from keys")
- **grin-wallet** or **Grim** for Grin
- Any BIP39-aware wallet for BTC/LTC

## Why

The v0.3 monorepo Smirk extension only supports v3 (Cake/grin-wallet
compatible) derivation. Users on v1/v2 from the legacy `smirk-extension`
who skip the in-wallet migration before uninstalling will see "0 balance"
in v0.3 because their funds are at different addresses.

Rather than carrying v1/v2 derivation + sweep flows in the monorepo
extension forever, we ship this one-time script as the recovery path:
the affected population is small and shrinking.

## Usage

```bash
# One-time setup: install monorepo deps, then build the packages the
# script imports (@smirk/core resolves to its dist/, which is not committed).
npm install
npm run build -w @smirk/assets -w @smirk/core

# Piped seed input — keeps seed out of shell history.
echo "twelve word phrase here" | npx tsx scripts/seed-to-keys/seed-to-keys.mjs

# Interactive (seed visible while typing — clear scrollback after).
npx tsx scripts/seed-to-keys/seed-to-keys.mjs
```

The script uses `tsx` so it runs straight from source with no bundler,
which keeps the offline / air-gapped use case simple. `@smirk/core`
itself has to be built once.

## Security notes

- **Never** pass the seed as a command-line argument — it would be
  visible in `ps` and saved to shell history.
- Run on a trusted, offline machine if possible. The script does not
  phone home, but a compromised machine sees the seed.
- Clear scrollback / close the terminal after you've recorded the keys
  you need.
- Output contains private keys. Treat like a seed.

## Future: in-browser HTML version

A single self-contained HTML page that does the same derivation in a
browser sandbox would be friendlier for non-CLI users. Not yet built:
the Node CLI covers the underlying logic; the HTML version is a
packaging task that loads `@smirk/wasm` + `@smirk/core/hd` via a
bundler.
