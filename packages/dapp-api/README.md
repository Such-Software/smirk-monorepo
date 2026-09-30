# @such-software/smirk-dapp-api

> Status: stable · Updated 2026-09-27 · Applies to: dapp API package contributors and consumers

This package defines Smirk's wallet request protocol, page adapters, and wallet
dispatcher. Platform shells supply transport, wallet operations, permissions, and
approval UI. See the [integration guide](../../docs/DAPP_INTEGRATION.md) for page
installation, compatibility, and network boundaries.

## Package boundaries

```text
Page: window.smirk.connect(['btc'])
  -> page adapter and request transport
  -> wallet-handler.ts
     -> permissions.ts: origin-scoped grants
     -> approval.ts: request consent
     -> provider.ts: wallet operations
```

The [protocol](src/protocol.ts) owns method inputs and results.
[page-api.ts](src/page-api.ts) defines the full page API and NIP-07 provider.
[wallet-handler.ts](src/wallet-handler.ts) validates requests and enforces
permissions. This package holds no wallet private keys.

## Adapters

| Adapter | Current use |
| --- | --- |
| `installSmirkApi` with a page transport | Full extension API through content-script and service-worker messaging |
| `installSmirkPageApi` | Dapp-installed iframe adapter, used by Linux desktop |
| `getPageApiInjectionScript` with Tauri transport | Native desktop webview injection on macOS and Windows |
| Capacitor script transport variant | Protocol preparation only; no mobile wallet shell is implemented |

These adapters expose different page method sets. The integration guide's
[page surface table](../../docs/DAPP_INTEGRATION.md#current-page-surfaces) records
the differences. A handler implementing a method does not make that method
available through every installer.

## Wallet dispatcher example

The factory functions below represent platform-owned adapters:

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
  return true;
});
```

Derive the origin from the browser's sender context, never from an origin field in
the page payload. The production extension bridge also validates sender routing
and request envelopes before dispatch.

## Handler capabilities

| Method group | Behavior |
| --- | --- |
| `connect`, `disconnect`, `isConnected` | Origin connection and asset scopes |
| `getPublicKeys`, `getAddresses` | Public identities for granted assets |
| `signMessage` | BTC, LTC, XMR, WOW, and Grin; consent per request |
| `requestPayment` | BTC, LTC, XMR, and WOW; consent per request |
| `claimPublicTip` | Tip claim with confirmation |
| `getBackend` | Selected backend URL for an unlocked, connected origin |
| `getNostrPublicKey` | Per-origin Nostr identity grant |
| `signNostrEvent` | Event signing subject to the kind policy and stored scopes |
| `getAppEncryptionKey`, `appSealOpen` | Origin-scoped encryption public key and sealed-box decryption |
| `nostrEncrypt`, `nostrDecrypt` | Wire methods used by NIP-44 and NIP-04 on `window.nostr` |

Nostr encryption methods are not flat methods on `window.smirk`. The full
installer exposes them through `window.nostr.nip44` and `window.nostr.nip04`.
It also exposes `getPublicKey`, `signEvent`, and `getRelays`; the latter returns
an empty relay map. An existing `window.nostr` provider is left unchanged.

Nostr identity, private-storage, and messaging grants can persist by origin.
Supported social kinds can receive a time-limited signing grant. Money-tier and
unknown event kinds require per-event consent. See [nostr-tiers.ts](src/nostr-tiers.ts).
An optional wallet password policy can still require confirmation for each private
operation. Stored scopes never bypass a locked or expired wallet.

## App-scoped encryption

`getAppEncryptionKey(context?)` returns an x25519 public key scoped to the calling
origin and optional context. The first call needs a connected origin and approval
for private storage. The wallet retains the private key.

```ts
import sodium from 'libsodium-wrappers';
await sodium.ready;

await window.smirk.connect();
const key = await window.smirk.getAppEncryptionKey('notes');
if (!key) throw new Error('Private-storage access was declined');

const sealed = sodium.crypto_box_seal(
  sodium.from_string('example note'),
  sodium.from_hex(key.publicKey),
);
// Store sealed bytes with the application's storage provider.
const plaintext = await window.smirk.appSealOpen(sealed, 'notes');
```

Anyone with the public key can seal data without contacting the wallet.
`appSealOpen` returns plaintext only for the granted origin and context.
The key is deterministic from the wallet recovery material; it is separate from
the wallet's asset keys and Nostr identity. Applications must feature-detect these
methods because embedded page adapters do not expose them yet.

## Development

Run `npm run build -w @such-software/smirk-dapp-api` and
`npm test -w @such-software/smirk-dapp-api` from the monorepo root.
The package manifest declares the MIT license.

## Reusable change checklist

- [ ] Updated protocol types, applicable page adapters, and handler behavior together.
- [ ] Derived origin authority from the transport.
- [ ] Tested consent, stored scopes, locked state, expiry, and malformed requests.
- [ ] Documented actual adapter exposure separately from handler support.
- [ ] Kept recovery material and private keys out of page responses.
