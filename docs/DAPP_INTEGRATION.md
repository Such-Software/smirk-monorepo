# Integrating Smirk into a dapp

> Status: stable · Updated 2026-09-27 · Applies to: v0.3.0 client source and dapp integrators

This guide describes the API implemented in this monorepo. The browser extension and
desktop embedded browser expose different method sets. Feature-detect each method
you use. Mobile integration is planned; this repository has no mobile wallet shell.

The [package reference](../packages/dapp-api/README.md) owns the protocol and API
details. The [embedded browser architecture](EMBEDDED_BROWSER.md) describes the
desktop transport and its trust boundaries. Older extension guides describe their
own releases and are not the authority for this client.

## Install the page adapter

Add this to your client bundle:

```ts
import { installSmirkPageApi } from '@such-software/smirk-dapp-api';

installSmirkPageApi();
```

The installer leaves an existing `window.smirk` unchanged, whether installed by
the extension or the desktop native webview. Otherwise, its default `auto` mode
installs the iframe adapter when the page has a parent frame. A top-level page
without an injected wallet keeps `window.smirk` undefined.

A parent frame alone does not prove that Smirk is present. A call can time out if
the parent does not implement the wallet protocol. Handle timeout, denial, locked
wallet, and unsupported-method errors in the page.

On Linux desktop, the dapp must include this installer because the wallet cannot
inject scripts into a cross-origin iframe. On macOS and Windows, the native
webview injects the core page API. Sites that block framing through CSP or
`X-Frame-Options` cannot load in the Linux iframe browser.

`mode: 'never'` skips iframe installation. `mode: 'force'` installs it even at
the top level for transport testing; it does not create a wallet. An existing API
always wins. The optional `walletOrigin` pins iframe responses to the expected
parent origin when an integration knows that origin.

## Current page surfaces

This table describes checked-in source, not store availability.

| Method or capability | Browser extension | Desktop macOS / Windows | Desktop Linux |
| --- | --- | --- | --- |
| Core connect, keys, addresses, message signing, payment, tip claim | Installed | Injected | Dapp installs iframe adapter |
| `disconnect`, `isConnected` | Installed | Absent | Installed by iframe adapter |
| `getBackend` | Installed | Absent | Absent |
| Nostr identity and event signing | Installed | Absent | Absent |
| App encryption methods | Installed | Absent | Absent |
| NIP-07 `window.nostr` provider | Installed if unclaimed | Absent | Absent |

The core methods are `connect`, `getPublicKeys`, `getAddresses`, `signMessage`,
`requestPayment`, and `claimPublicTip`. Payments support BTC, LTC, XMR, and WOW;
the dapp payment method does not support Grin. The wallet-side dispatcher knows
more methods than the embedded page adapters currently expose.

Do not use a package version or wallet release number as a substitute for feature
detection. The full page API's `version` and the embedded API's
`protocolVersion()` describe the wire protocol, not the wallet release.

## Connect and sign

```ts
if (typeof window.smirk?.connect !== 'function') {
  // Show an install-wallet or open-in-Smirk fallback.
  return;
}
const keys = await window.smirk.connect(['btc', 'ltc']);
const signed = await window.smirk.signMessage('The exact message shown to the user');
```

Connection approval grants an origin access to the selected public asset
identities. Repeated calls can use that stored permission. Message signing and
payment requests require approval for the specific request. A stored permission
does not unlock the wallet.

The user's optional password confirmation settings apply in addition to dapp
consent. They can require a password for every send or every signing operation.
Confirming one action does not extend the wallet's auto-lock deadline.

## Sign in with Nostr

Feature-detect both methods before offering this flow:

```ts
if (typeof window.smirk?.getNostrPublicKey !== 'function'
    || typeof window.smirk?.signNostrEvent !== 'function') {
  return;
}

const pubkey = await window.smirk.getNostrPublicKey();
if (!pubkey) return; // The user declined the identity grant.

const signed = await window.smirk.signNostrEvent({
  kind: 27235,
  content: '',
  tags: [
    ['u', 'https://your-dapp.example/api/login'],
    ['method', 'POST'],
  ],
});
```

The first identity grant lets the user choose the Nostr identity shared with the
origin, including a separate site identity. Later requests use that selected
identity. The page receives public keys and signed events, never private keys.

The dapp sends the signed event to its own server. The server must verify the
NIP-01 event ID and signature, request URL and method, timestamp freshness, and any
payload or challenge binding its authentication protocol requires.

NIP-98 events require a parseable absolute URL in the `u` tag. Smirk refuses a
request targeting the user's own wallet backend host through this dapp interface.
Authentication and other money-tier events always require approval per event.

For supported social event kinds, users may grant a time-limited signing scope
to an origin. Those events can then be signed without another consent prompt
while the wallet remains unlocked. Unknown kinds require approval per event.
The [tier policy source](../packages/dapp-api/src/nostr-tiers.ts) defines the
allowed kinds. Password confirmation preferences still apply.

When available, `getBackend()` returns the wallet's selected backend URL to an
unlocked, connected origin. It is absent from the current embedded page adapters.

## Wire format

The iframe adapter posts a request to its parent:

```jsonc
{
  "channel": "smirk:dapp",
  "payload": {
    "type": "SMIRK_REQUEST",
    "v": 1,
    "id": 7,
    "method": "connect",
    "params": { "assets": ["btc", "ltc"] }
  }
}
```

The wallet returns a matching response:

```jsonc
{
  "channel": "smirk:dapp",
  "payload": {
    "type": "SMIRK_RESPONSE",
    "v": 1,
    "id": 7,
    "result": { /* method-specific result */ }
    // Or "error": { "code": "...", "message": "..." }
  }
}
```

The page adapter matches responses by request ID and accepts them only from its
parent frame, plus the configured parent origin if provided. The wallet resolves
the requesting origin from the browser transport, not a field supplied by the page.
See [protocol.ts](../packages/dapp-api/src/protocol.ts) for the method-specific types.

## Network and privacy boundaries

Bundle the adapter with the dapp. It does not require a Smirk-hosted script CDN.
Message signing, Nostr event signing, and app-key cryptography execute in the
wallet. The dapp remains responsible for its own authentication and publication
requests.

Payments and tip claims use the wallet's configured backend and chain providers.
Other wallet activity can also contact that backend or configured relays. Those
services can receive network metadata; a call through `window.smirk` is not a
guarantee that no network request occurs. Describe the actual operation to users.

## Reusable integration checklist

- [ ] Bundled the iframe adapter when supporting Linux desktop.
- [ ] Feature-detected every optional method and handled denial, lock, and timeout.
- [ ] Tested only the platforms and methods claimed by the integration.
- [ ] Kept public connection scopes separate from approval to sign or send.
- [ ] Verified authentication events against the intended request on the server.
- [ ] Described backend and relay use without promising that all calls are offline.
