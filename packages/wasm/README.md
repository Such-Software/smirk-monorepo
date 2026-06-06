# @smirk/wasm

TypeScript bindings for the `smirk-wasm` WASM crypto bundle.

This package answers one question:

> How does TypeScript code in any Smirk shell (extension, desktop,
> mobile) call into the Rust crypto for chain-specific signing
> and key derivation, without re-implementing wasm-bindgen
> ergonomics at every call site?

The underlying WASM is built from `crates/smirk-wasm/` and exposes
per-chain functions (`grin.*`, `monero.*`, etc.). This package
wraps that surface as ergonomic JS modules with idempotent
initialisation and namespaced re-exports.

## Build

The WASM bundle must exist before this package can build. From
the monorepo root:

```sh
make wasm        # browser target → crates/smirk-wasm/pkg/
make wasm-node   # Node target    → crates/smirk-wasm/pkg-node/
```

`@smirk/wasm` builds against the browser target by default.

## Use — browser

```ts
import { initialize, grin, monero } from '@smirk/wasm';

await initialize();
// fetches & instantiates the .wasm next to the loader

const address = grin.slatepackAddress(mnemonic, 0, 'mainnet');
const xmrTx   = monero.constructTransaction(...);
```

## Use — Node / restricted-fetch environments

```ts
import { initialize, grin } from '@smirk/wasm';
import { readFileSync } from 'fs';

const wasmBytes = readFileSync('node_modules/@smirk/wasm/pkg/smirk_wasm_bg.wasm');
await initialize(wasmBytes);
```

The mobile WebView's restricted fetch behaviour also goes through
the explicit-bytes path.

## Namespaces

| Namespace | Coverage                                                       |
|-----------|----------------------------------------------------------------|
| `grin`    | Slatepack address derivation, slate construction, sweeps       |
| `monero`  | Address derivation, ringct tx construction, output decoding    |
| `wownero` | Reuses `monero.*` shapes (delta is on the chain side, not crypto) |

Initialisation is idempotent — every shell can call it on boot
without coordinating with the others.

## License

MIT OR Apache-2.0.
