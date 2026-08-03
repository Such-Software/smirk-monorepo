# smirk-wasm

Monero/Wownero, Grin, and Bitcoin/Litecoin cryptographic operations for browser extensions, compiled to WebAssembly.

## Overview

This crate provides client-side cryptographic operations for Monero and Wownero wallets running in browser extensions. The spend key never leaves the client - the backend only provides blockchain data.

## Features

- **Address validation** - Parse and validate Monero/Wownero addresses
- **Key image computation** - Compute key images to verify spent outputs (client-side balance verification)
- **Transaction parsing** - Decode and inspect transactions
- **Fee estimation** - Estimate transaction fees
- **Transaction signing** - Construct and sign transactions locally (XMR and WOW)

## Wownero Support

Wownero transactions are fully supported with the following differences from Monero:

| Property | Monero (XMR) | Wownero (WOW) |
|----------|--------------|---------------|
| RCT Type | 6 (ClsagBulletproofPlus) | 8 (BulletproofPlus) |
| Ring Size | 16 (15 decoys + 1 real) | 22 (21 decoys + 1 real) |
| Commitment Format | Full commitment | C/8 (scaled by INV_EIGHT) |
| Network Prefix | `4` (mainnet) | `Wo` (mainnet) |

The signing implementation handles these differences automatically based on the `coin` parameter (`"xmr"` or `"wow"`), independently of `network`.

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  Browser Extension  │     │      Backend        │
│                     │     │                     │
│  ┌───────────────┐  │     │  ┌───────────────┐  │
│  │  smirk-wasm   │  │     │  │     LWS       │  │
│  │               │  │     │  │  (Monero)     │  │
│  │               │  │     │  │               │  │
│  │ - Keys        │◄─┼─────┼──┤ - Outputs     │  │
│  │ - Signing     │  │     │  │ - Decoys      │  │
│  │ - Addresses   │──┼─────┼──► - Broadcast   │  │
│  └───────────────┘  │     │  └───────────────┘  │
│                     │     │                     │
│  Spend key stays    │     │  No access to       │
│  here               │     │  spend key          │
└─────────────────────┘     └─────────────────────┘
```

## Building

### Prerequisites

- Rust (stable) with `wasm32-unknown-unknown` target
- wasm-bindgen-cli

```bash
# Add WASM target
rustup target add wasm32-unknown-unknown

# Install wasm-bindgen CLI
cargo install wasm-bindgen-cli
```

### Build

`make wasm` from the monorepo root is the preferred entry point: it also
sets the `--remap-path-prefix` flags that keep the wasm reproducible.

```bash
# Quick build (uses build.sh)
./build.sh

# Or manually, from the monorepo root:
cargo build -p smirk-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target no-modules --out-dir crates/smirk-wasm/pkg \
  target/wasm32-unknown-unknown/release/smirk_wasm.wasm
node crates/smirk-wasm/postprocess.mjs
```

The `postprocess.mjs` step is not optional: it stubs the broken
`require("env")` C-import placeholders and appends
`export { wasm_bindgen };` so `@smirk/wasm` can import the IIFE-bound
symbol as a plain ES module export.

### Output

After building:
- `pkg/smirk_wasm.js` - JavaScript module
- `pkg/smirk_wasm.d.ts` - TypeScript definitions
- `pkg/smirk_wasm_bg.wasm` - WebAssembly binary

## Testing

### Rust unit tests
```bash
cargo test
```

### Browser testing
```bash
# Build first
./build.sh

# Serve with any static server
python3 -m http.server 8080

# Open http://localhost:8080/test.html
```

`test.html` predates the `--target no-modules` switch and still imports the
`--target web` ESM shape (`import init, { ... }`), so it does not load the
bundle `build.sh` emits. Rebuild with `--target web` to use it, or drive the
shipped bundle the way `packages/wasm/src/index.ts` does.

## Usage

```javascript
import { wasm_bindgen } from './pkg/smirk_wasm.js';

async function main() {
  // Loads and instantiates the WASM, then attaches every export to the
  // `wasm_bindgen` function object.
  await wasm_bindgen();

  const {
    test,
    version,
    validate_address,
    estimate_fee,
    sign_transaction,
    compute_key_image
  } = wasm_bindgen;

  // Verify loaded
  console.log(test()); // "smirk-wasm ready"

  // Validate address
  const result = JSON.parse(validate_address(
    '888tNkZrPN6JsEgekjMnABU4TBzc...'
  ));
  if (result.success) {
    console.log(result.data.network); // "mainnet"
  }

  // Estimate fee (2 inputs, 2 outputs)
  const fee = JSON.parse(estimate_fee(2, 2, 20n, 10000n));
  console.log(fee.data); // fee in atomic units

  // Sign transaction
  const txResult = JSON.parse(sign_transaction(JSON.stringify({
    inputs: [/* from get_unspent_outs + get_random_outs */],
    destinations: [{ address: '...', amount: 1000000 }],
    change_address: '...',
    fee_per_byte: 20,
    fee_mask: 10000,
    view_key: '...', // hex
    spend_key: '...', // hex
    network: 'mainnet'
  })));
  if (txResult.success) {
    console.log(txResult.data.tx_hex);  // signed tx ready for broadcast
    console.log(txResult.data.tx_hash); // transaction hash
    console.log(txResult.data.fee);     // actual fee
  }
}
```

## API

All functions return JSON strings:
```typescript
interface Result<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

### Core Functions

| Function | Description |
|----------|-------------|
| `test()` | Returns `"smirk-wasm ready"` if loaded |
| `version()` | Returns crate version |

### Address Functions

#### `validate_address(address: string) -> string`

Validates a Monero address and returns its components.

```typescript
// Returns:
{
  valid: boolean;
  network: "mainnet" | "testnet" | "stagenet";
  is_subaddress: boolean;
  has_payment_id: boolean;
  spend_key: string;  // hex
  view_key: string;   // hex
}
```

### Key Functions

#### `derive_key_image(output_key, spend_key, key_offset) -> string`

Computes the key image for an output. All arguments are 32-byte hex strings.

Returns the key image as a hex string.

### Transaction Functions

#### `parse_tx(hex_data: string) -> string`

Parses a transaction from hex.

```typescript
// Returns:
{
  inputs: number;
  outputs: number;
  version: number;
}
```

#### `estimate_fee(inputs, outputs, fee_per_byte, fee_mask) -> string`

Estimates transaction fee.

- `inputs` - Number of inputs (u32)
- `outputs` - Number of outputs including change (u32)
- `fee_per_byte` - Fee per byte from LWS (u64/bigint)
- `fee_mask` - Fee rounding mask from LWS (u64/bigint)

Returns estimated fee in atomic units.

#### `sign_transaction(params_json: string) -> string`

Builds and signs a transaction.

**Input format:**
```typescript
{
  inputs: [{
    output: {
      amount: number,      // atomic units
      public_key: string,  // hex
      tx_pub_key: string,  // hex
      index: number,       // output index in tx
      global_index: number,// global output index
      height: number,      // block height; required
      subaddr_index?: {    // omit only for primary-address outputs
        major: number,
        minor: number
      }
    },
    decoys: [{             // XMR: 15 decoys (ring 16), WOW: 21 decoys (ring 22)
      global_index: number,
      public_key: string,  // hex
      rct: string          // hex commitment
    }]
  }],
  destinations: [{ address: string, amount: number }],
  change_address: string,
  fee_per_byte: number,
  fee_mask: number,
  view_key: string,        // hex, 64 chars
  spend_key: string,       // hex, 64 chars
  network: "mainnet" | "testnet" | "stagenet", // default "mainnet"
  coin: "xmr" | "wow"      // default "xmr"; selects RCT type and ring size
}
```

`subaddr_index` is what folds the subaddress spend secret into the key
offset. Omit it on an output received on a subaddress and the key image
will not match on-chain.

`coin` is independent of `network`. Omit it for a Wownero transaction and
the tx is built with Monero's RCT type and 15-decoy ring.

**Returns:**
```typescript
{
  tx_hex: string,   // signed transaction ready for broadcast
  tx_hash: string,  // transaction hash
  fee: number       // actual fee in atomic units
}
```

#### `derive_output_key_image(view_key, spend_key, tx_pub_key, output_index, output_key) -> string`

Derives the key image for a specific output when you have the output's public key.

#### `compute_key_image(view_key, spend_key, tx_pub_key, output_index) -> string`

Computes the key image for an output without requiring the output public key. This is useful for verifying LWS `spent_outputs` where only `tx_pub_key` and `out_index` are provided.

The function:
1. Derives the one-time private key: `x = Hs(a*R || outputIndex) + b`
2. Computes the output public key: `P = x * G`
3. Returns the key image: `KI = x * Hp(P)`

This uses `monero-oxide`'s `Point::biased_hash` for the `Hp()` operation, which is Monero's `hash_to_ec` (ge_fromfe_frombytes_vartime).

## Project Structure

```
smirk-wasm/
├── Cargo.toml
├── build.sh
├── postprocess.mjs     # Required patch step on the no-modules output
├── README.md
├── test.html
└── src/
    ├── lib.rs          # Main module, re-exports
    ├── result.rs       # WasmResult type
    ├── address.rs      # Address validation
    ├── keys.rs         # Key image derivation
    ├── output.rs       # Output derivation (key_offset, commitment_mask)
    ├── transaction.rs  # Transaction parsing
    ├── signing.rs      # Transaction signing
    ├── bitcoin.rs      # BTC/LTC address derivation + PSBT build/sign/extract
    ├── grin/           # Grin slate ceremonies, slatepack codec, kernels, vouchers
    ├── wasm_libc_shim.rs # malloc/free shims for the vendored secp256k1-zkp C code
    └── tests.rs        # Unit tests
```

## Dependencies

- [monero-oxide](https://github.com/monero-oxide/monero-oxide) - Pure Rust Monero implementation (MIT)
- [curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) - Elliptic curve ops
- [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) - Rust/JS interop

## License

MIT
