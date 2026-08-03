# @such-software/smirk-dapp-api

Transport-agnostic dapp-injection layer for Smirk Wallet.

This package answers one question:

> How does a webpage call into a wallet for `connect`,
> `signMessage`, `requestPayment`, and friends, without coupling
> the protocol to the transport (browser-extension messaging vs.
> Tauri events vs. Capacitor bridges)?

It defines the wire protocol, the page-side `window.smirk`
installer, and the wallet-side dispatcher. Platform shells provide
the transport adapter and the wallet glue.

## Three layers

```
┌─────────────────────────────────────────────────┐
│ Page                                            │
│   window.smirk.connect({assets:['btc']})        │
│        │                                        │
│        ▼                                        │
│ page-api.ts / page-api-script.ts                │ ← installSmirkApi
│        │                                        │
└────────┼────────────────────────────────────────┘
         │ wire (JSON-RPC-shaped, see protocol.ts)
┌────────▼────────────────────────────────────────┐
│ Wallet                                          │
│   wallet-handler.ts                             │ ← createWalletHandler
│   ├── provider.ts       (wallet ops)            │
│   ├── permissions.ts    (per-origin policy)     │
│   └── approval.ts       (user prompts)          │
└─────────────────────────────────────────────────┘
```

## Transports

Two variants ship today (`postMessage`, `tauri`), picked by the platform shell; the
`capacitor` variant is defined on the page side and awaits its mobile shell:

| Variant       | Page side                   | Wallet side                  |
|---------------|-----------------------------|------------------------------|
| `postMessage` | iframe / cross-window pages | extension content + SW       |
| `tauri`       | `window.__TAURI__.event`    | desktop's `browser_plugin.rs`|
| `capacitor`   | `window.SmirkBrowserBridge` | mobile's native plugin (planned, v0.4) |

See `src/page-api-script.ts` for the IIFE that bootstraps
`window.smirk` against the chosen transport.

## Use: extension service worker

```ts
import { createWalletHandler } from '@such-software/smirk-dapp-api';

const dispatch = createWalletHandler({
  provider: chromeWalletProvider(),
  permissions: chromeStoragePermissionStore(),
  approval: chromePopupApprovalHandler(),
});

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg?.type !== 'SMIRK_REQUEST') return;
  dispatch(msg, originContextFrom(sender)).then(send);
  return true; // async
});
```

## Status

| Method                 | Implemented |
|------------------------|-------------|
| `connect`              | ✓           |
| `disconnect`           | ✓           |
| `isConnected`          | ✓           |
| `getPublicKeys`        | ✓           |
| `getAddresses`         | ✓           |
| `signMessage`          | ✓ (BTC, LTC, XMR, WOW, Grin) |
| `requestPayment`       | ✓ (BTC, LTC, XMR, WOW)       |
| `claimPublicTip`       | ✓           |
| `getBackend`           | ✓           |
| `getNostrPublicKey`    | ✓: one-time per-origin npub grant (NIP-06 identity)  |
| `signNostrEvent`       | ✓: NIP-98 login, notes; prompts per signature        |
| `getAppEncryptionKey`  | ✓: app-scoped x25519 sealing key (see below)         |
| `appSealOpen`          | ✓: open a `crypto_box_seal` addressed to that key    |
| `nostrEncrypt`         | ✓: NIP-44 (default) / NIP-04 DM encrypt; prompts on the origin's first crypto call, silent after |
| `nostrDecrypt`         | ✓: inverse of `nostrEncrypt`                        |

### NIP-07 provider at `window.nostr`

`installSmirkApi` also installs a standard NIP-07 provider at `window.nostr`
(`getPublicKey`, `signEvent`, `nip44`, `nip04`, `getRelays`), backed by the same
methods as `window.smirk`. It is skipped when another signer has already claimed the
property, so an installed Alby or nos2x stays primary.

### App-scoped end-to-end encryption

`getAppEncryptionKey(context?)` returns a deterministic, seed-derived **x25519
public key** unique to the calling origin. Seal data to it with libsodium
`crypto_box_seal`; the server can't read it, and writes need no wallet round-trip:

```ts
import sodium from 'libsodium-wrappers';
await sodium.ready;

await window.smirk.connect();  // the e2ee scope sits on top of a connection
const key = await window.smirk.getAppEncryptionKey('notes');
if (!key) throw new Error('user declined the private-storage grant');
const sealed = sodium.crypto_box_seal(sodium.from_string('secret'), sodium.from_hex(key.publicKey));
// store `sealed` server-side ...

const plaintext = await window.smirk.appSealOpen(sealed, 'notes'); // Uint8Array
```

The first call prompts a one-time "allow private storage" grant. The wallet holds
the private half and only ever *opens* boxes; the key is never exported. `context`
sub-scopes the key so one origin can hold several unlinkable keys. The key is
unrelated to the user's Nostr identity or funds, and stable across reinstalls
(re-derived from the seed).

## License

MIT OR Apache-2.0.
