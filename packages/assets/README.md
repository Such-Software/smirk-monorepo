# @smirk/assets

Asset registry for Smirk Wallet.

This package answers one question:

> Which chains does Smirk support, and what is their static metadata
> — decimals, family, network params, capability flags?

Definitions are pure data. The registry knows nothing about
signing, address derivation, or transaction construction — those
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

// Iterate everything that routes through THORChain
for (const a of registry.list({ swapRoute: 'thorchain' })) {
  console.log(a.ticker);
}
```

## Add a new asset

1. Create `src/assets/<id>.ts` exporting an `AssetDefinition`.
2. Import + register it in `src/index.ts`.
3. Update `ASSET_IDS` if the id is new.

The registry is open-ended at runtime — third-party consumers can
`registry.register(...)` their own definitions without forking.

## License

MIT OR Apache-2.0.
