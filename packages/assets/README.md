# @smirk/assets

> Status: stable · Updated 2026-09-27 · Applies to: Smirk client source

Asset registry for Smirk Wallet.

The registry owns static chain metadata: decimals, family, network parameters
and capability flags.

Definitions are pure data. The registry knows nothing about
signing, address derivation, or transaction construction: those
live in `@smirk/wasm` (Rust crypto, per chain) and `@smirk/core`
(pure-JS chain helpers). Composing the registry with adapter code
at the call site keeps this package importable from any context.

## Layout

```
src/
├── registry.ts        # AssetRegistry class (list/get/register)
├── types.ts           # AssetDefinition + family-specific shape unions
├── assets/
│   ├── btc.ts         # Bitcoin (UTXO family)
│   ├── ltc.ts         # Litecoin (UTXO family)
│   ├── xmr.ts         # Monero (Cryptonote family)
│   ├── wow.ts         # Wownero (Cryptonote family)
│   └── grin.ts        # Grin (Mimblewimble family)
└── index.ts           # Built-in registration on module load
```

## Use

```ts
import { registry, ASSET_IDS } from '@smirk/assets';

const btc = registry.mustGet(ASSET_IDS.BTC);
console.log(btc.decimals); // 8

// Select assets by chain family. Registry metadata does not activate a provider.
for (const a of registry.list({ family: 'utxo' })) {
  console.log(a.ticker);
}
```

## Add a new asset

1. Create `src/assets/<id>.ts` exporting an `AssetDefinition`.
2. Import + register it in `src/index.ts`.
3. Update `ASSET_IDS` if the id is new.
4. Implement and verify the derivation, signing and backend adapters before
   enabling the asset. A registry entry alone does not make it spendable.

The registry is open-ended at runtime: third-party consumers can
`registry.register(...)` their own definitions without forking.

## License

MIT OR Apache-2.0.

## Maintenance checklist

- [ ] Behavior and commands match the current source.
- [ ] Verification and failure conditions are described.
- [ ] Planned work is distinguished from available features.
- [ ] No private operational evidence or credential values are included.
