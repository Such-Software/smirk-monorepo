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

## Use: browser

```ts
import { initialize, grin, monero } from '@smirk/wasm';

await initialize();
// fetches & instantiates the .wasm next to the loader

const address = grin.slatepackAddress(mnemonic, 0, 'mainnet');
const xmrTx   = monero.signTransaction(JSON.stringify(params));
```

## Use: Node / restricted-fetch environments

```ts
import { initialize, grin } from '@smirk/wasm';
import { readFileSync } from 'fs';

// Path relative to the monorepo root; `make wasm` produces it.
const wasmBytes = readFileSync('crates/smirk-wasm/pkg/smirk_wasm_bg.wasm');
await initialize(wasmBytes);
```

The mobile WebView's restricted fetch behaviour also goes through
the explicit-bytes path.

The package publishes only `dist/` and `src/`, so the `.wasm` is not
inside the installed package: a consuming app resolves or bundles those
bytes itself.

## Namespaces

| Namespace | Coverage                                                       |
|-----------|----------------------------------------------------------------|
| `grin`    | Slatepack address derivation, slate + invoice ceremonies, slatepack codec, vouchers |
| `monero`  | Address validation, key-image derivation, fee estimation, ringct tx signing |
| `bitcoin` | BTC + LTC address derivation (BIP84 / BIP86) and PSBT build, sign, extract |

There is no `wownero` namespace: `coin: "xmr" | "wow"` in the signing
params selects Monero or Wownero, since the delta is on the chain side,
not the crypto.

Initialisation is idempotent: every shell can call it on boot
without coordinating with the others.

## License

MIT OR Apache-2.0.
