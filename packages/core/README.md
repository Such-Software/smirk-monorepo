# @smirk/core

Platform-agnostic wallet core for Smirk.

This package answers one question:

> What is the wallet logic that doesn't care whether it's running
> inside a browser extension, a desktop app, or a mobile WebView?

It's the shared TypeScript layer underneath every Smirk surface
(`@smirk/extension`, `@smirk/desktop`, future `@smirk/mobile`).

## What's inside

- **API client** (`src/api/`): full-fat client for the Smirk
  backend: `auth`, `keys`, `tips`, `social`, `wallet/utxo`,
  `wallet/lws`, `grin/relay`, `prices`.
- **Keystore** (`src/keystore.ts`): encrypted-at-rest seed
  storage + unlock state machine. PBKDF2 + XChaCha20-Poly1305.
- **HD derivation** (`src/hd.ts`): BIP-32 / SLIP-10 paths for
  each supported chain family.
- **Address derivation + validation** (`src/address.ts`): pure-JS
  derivation for BTC, LTC, Grin slatepacks; XMR / WOW addresses
  derive in `@smirk/wasm`.
- **Crypto** (`src/crypto.ts`): tip-envelope encryption
  (secp256k1 ECDH), Bitcoin message signing (BIP-137), random
  helpers.
- **Wallet bootstrap** (`src/wallet-flow.ts`): composes the
  keystore + API client into the auth + balances flow every shell
  uses on unlock.
- **State** (`src/state/`): `PlatformStorage` abstraction with
  Chrome / localStorage / in-memory backends. Used to share
  preferences, routes, and wizard scaffolding between shells.

## What's deliberately not inside

- Chain-specific transaction crypto: in `@smirk/wasm` (Rust).
- UI components: in `@smirk/ui`.
- Browser-extension specifics (`chrome.*`): in `@smirk/extension`.

`@smirk/core` is importable from any JS context (browser, service
worker, Node, Deno). It depends on no DOM or `chrome.*` API; never
add one.

## Use

```ts
import { createKeystore, unlockKeystore } from '@smirk/core';
import { SmirkApi, bootstrapAuth } from '@smirk/core';

const api = new SmirkApi();
const keystore = await createKeystore(mnemonic, password);
const wallet = await unlockKeystore(keystore, password);
const bootstrap = await bootstrapAuth(api, wallet);
```

## License

MIT.
