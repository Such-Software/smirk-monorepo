# @smirk/core

> Status: stable · Updated 2026-09-27 · Applies to: shared Smirk wallet runtime

Shared TypeScript logic for the extension and desktop wallet. Platform adapters
supply persistent storage, foreground approval and network access. Mobile is a
future consumer. Importing the package does not initialize WASM or require a
browser DOM.

## Keys, storage and sessions

`createKeystore` encrypts a validated mnemonic with PBKDF2 and
XChaCha20-Poly1305. `unlockKeystore` decrypts it and derives wallet keys.
`WalletKeystore` manages persisted keystore state, locking, password verification
and exact active-wallet checks. Wrong passwords, expired sessions and stale
wallet instances refuse before signing.

Grace-period caches contain complete scoped signing authority, never the
recovery phrase, BIP39 seed or BIP32 master root. The extension owns cache
storage and cross-window revocation. See the [session contract](../../docs/ARCHITECTURE.md#wallet-unlock-lifetime)
for expiry, handoff and version migration behavior. These keys still authorize
spending during the unlocked lifetime, so session storage is sensitive.

`src/hd.ts` and `src/address.ts` provide derivation and address codecs for the
supported chain families. Rust/WASM supplies transaction construction and
chain-specific cryptographic operations. Backend requests receive only the
material described in [PRIVACY.md](../../PRIVACY.md).

## Identity and messaging

`src/nostr/` owns NIP-06 identities, per-origin identities, encrypted identity
vaults, NIP-98 authentication, event signing and app-scoped encryption.
`NostrKeySource` accepts either the fresh mnemonic or scoped session roots.
Restored sessions must derive the same public keys and decrypt existing vaults.
Missing selected identity material must not silently fall back to account 0.

Derived identities follow the recovery phrase. Random burner and imported keys
are encrypted in the identity vault and need a separate vault backup. App keys
are separated by origin and context; a sealed message for one context must not
open in another. Private key material never belongs in a log or API response.

`src/messaging/` composes the selected provider and relay configuration for
NIP-17 direct messages. Grin slatepack transport has a separate backend/Nostr
channel interface. Relay publication reports delivery limitations; it does not
prove the recipient read a message.

## API, balances and state

`SmirkApi` owns the typed backend methods and public configuration. The generated
schema comes from `openapi.json`; regenerate with `npm run gen:api -w @smirk/core`
and check drift with `npm run check:api -w @smirk/core`.

`bootstrapAuth` restores known scan heights before authentication. A failed or
malformed history lookup refuses; it cannot establish that a wallet is new.
Capabilities govern optional operations. A failed balance fetch retains an
explicit stale/error state instead of becoming a fresh zero balance.

`src/state/` owns the platform storage interface, session preferences, routing
and persisted wizard transitions. `Wizard.start` can prepare an existing draft
inside its serialized storage update, avoiding a first-render hydration race.
Transaction amounts remain integer atomic units; fiat conversions are display
estimates.

## Use and verify

```ts
import { createKeystore, unlockKeystore, SmirkApi, bootstrapAuth } from '@smirk/core';

// mnemonic and password come from an explicit user flow, never source literals.
const keystore = await createKeystore(mnemonic, password);
const wallet = await unlockKeystore(keystore, password);
const api = new SmirkApi();
const bootstrap = await bootstrapAuth(api, wallet);
```

Run `npm test -w @smirk/core` and `npm run typecheck -w @smirk/core` after building
dependencies with `make libs`. Scoped-key tests compare established derivations
and verify real signatures; app decryption tests use libsodium as the independent
sealing implementation. Backend integration requires the separate disposable
backend test lane described in [TESTING.md](../../docs/TESTING.md).

## Maintenance checklist

- [ ] New optional capabilities stay closed until explicitly admitted.
- [ ] Secret material remains outside persistent plaintext storage and output.
- [ ] Restored and fresh sessions agree on addresses and signing authority.
- [ ] Failure states cannot become fresh balance, history or identity evidence.
- [ ] Generated API declarations are regenerated from their source.
- [ ] Regression tests check behavior and independent cryptographic properties.

## License

MIT.
