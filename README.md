# smirk-wasm

Monero/Wownero transaction construction for browser extensions, compiled to WebAssembly.

## Overview

This crate provides client-side cryptographic operations for Monero and Wownero wallets running in browser extensions. The spend key never leaves the client - the backend only provides blockchain data.

## Features

- **Address validation** - Parse and validate Monero/Wownero addresses
- **Key image derivation** - Compute key images to detect spent outputs
- **Transaction parsing** - Decode and inspect transactions
- **Fee estimation** - Estimate transaction fees
- **Transaction signing** (WIP) - Construct and sign transactions locally

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  Browser Extension  │     │      Backend        │
│                     │     │                     │
│  ┌───────────────┐  │     │  ┌───────────────┐  │
│  │  smirk-wasm   │  │     │  │     LWS       │  │
│  │  (~165KB)     │  │     │  │  (Monero)     │  │
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

```bash
# Quick build (uses build.sh)
./build.sh

# Or manually:
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/smirk_wasm.wasm
```

### Output

After building:
- `pkg/smirk_wasm.js` - JavaScript module
- `pkg/smirk_wasm.d.ts` - TypeScript definitions
- `pkg/smirk_wasm_bg.wasm` - WebAssembly binary (~165KB)

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

## Usage

```javascript
import init, {
  test,
  version,
  validate_address,
  estimate_fee
} from './pkg/smirk_wasm.js';

async function main() {
  // Initialize WASM
  await init();

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

#### `sign_transaction(params_json: string) -> string` (WIP)

Builds and signs a transaction. Not yet implemented.

## Project Structure

```
smirk-wasm/
├── Cargo.toml
├── build.sh
├── README.md
├── test.html
└── src/
    ├── lib.rs          # Main module, re-exports
    ├── result.rs       # WasmResult type
    ├── address.rs      # Address validation
    ├── keys.rs         # Key image derivation
    ├── transaction.rs  # Transaction parsing
    ├── signing.rs      # Transaction signing (WIP)
    └── tests.rs        # Unit tests
```

## Dependencies

- [monero-oxide](https://github.com/monero-oxide/monero-oxide) - Pure Rust Monero implementation (MIT)
- [curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) - Elliptic curve ops
- [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) - Rust/JS interop

## License

MIT
