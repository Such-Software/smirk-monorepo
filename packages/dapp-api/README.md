# @smirk/dapp-api

Transport-agnostic dapp-injection layer for Smirk Wallet.

This package answers one question:

> How does a webpage call into a wallet for `connect`,
> `signMessage`, `requestPayment`, and friends — without coupling
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

Three variants ship today, picked by the platform shell:

| Variant       | Page side                   | Wallet side                  |
|---------------|-----------------------------|------------------------------|
| `postMessage` | iframe / cross-window pages | extension content + SW       |
| `tauri`       | `window.__TAURI__.event`    | desktop's `browser_plugin.rs`|
| `capacitor`   | `window.SmirkBrowserBridge` | mobile's native plugin       |

See `src/page-api-script.ts` for the IIFE that bootstraps
`window.smirk` against the chosen transport.

## Use — extension service worker

```ts
import { createWalletHandler } from '@smirk/dapp-api';

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

| Method            | Implemented |
|-------------------|-------------|
| `isInstalled`     | ✓           |
| `protocolVersion` | ✓           |
| `isUnlocked`      | ✓           |
| `connect`         | ✓           |
| `getAddresses`    | ✓           |
| `getPublicKeys`   | ✓           |
| `signMessage`     | ✓ (BTC, LTC) — XMR/WOW/Grin tracked for follow-up |
| `requestPayment`  | wired in protocol; wallet-side handoff planned for v0.3.x |
| `claimPublicTip`  | wired in protocol; UI handoff planned for v0.3.x          |

## License

MIT OR Apache-2.0.
