# seed-to-keys

Standalone recovery tool for users on legacy Smirk derivations (v1, v2)
who want to import their funds into a non-Smirk wallet.

## What it does

Takes a 12-word BIP39 mnemonic and prints:

- BTC + LTC: WIF/hex private keys + bech32 addresses (unchanged across
  Smirk derivation generations — these always used BIP44 standard paths)
- XMR + WOW: private spend key, private view key, public address, at
  all three derivation generations (v1, v2, v3)
- Grin: slatepack address + private key, at all three generations

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
extension forever, we ship this one-time script as the recovery path.
See `docs/V0_3_PLAN.md` → "Legacy v1/v2 migration" for the population
data that informed this decision (40 unmigrated users, <$50 total max
exposure as of 2026-05-11).

## Usage

```bash
# One-time setup: install monorepo deps (the script imports @smirk/core source via tsx)
npm install

# Piped seed input — keeps seed out of shell history.
echo "twelve word phrase here" | npx tsx scripts/seed-to-keys/seed-to-keys.mjs

# Interactive (seed visible while typing — clear scrollback after).
npx tsx scripts/seed-to-keys/seed-to-keys.mjs
```

The script uses `tsx` so it can import `@smirk/core` source directly
without a build step — keeps the offline / air-gapped use case simple.

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
browser sandbox would be friendlier for non-CLI users (and easier to
DM to the 7 known WOW-balance-holders). Not yet built — the Node CLI
covers the underlying logic; the HTML version is a packaging task that
loads `@smirk/wasm` + `@smirk/core/hd` via a bundler. Tracked in
`smirk-backend/docs/TECHNICAL_DEBT.md` item #11.
