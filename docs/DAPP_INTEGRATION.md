# Integrating Smirk into Your Dapp

A guide for websites, web games, and login systems that want users to authenticate or pay with their Smirk wallet. Covers the v0.2.x browser extension surface that already exists on play.wowne.ro / smirk.cash, the v0.3.0 desktop wallet's embedded browser, and the planned v0.4 Capacitor mobile surface.

Companion to the v0.2.x [legacy integration guide](https://github.com/Such-Software/smirk-extension/blob/main/docs/INTEGRATION.md) — that doc still applies for everything that targets the browser extension. This guide describes what changed in v0.3.0 and how to support both old and new wallet shapes from the same codebase.

## The short version

Add this near the top of your page bundle:

```ts
import { installSmirkPageApi } from '@smirk/dapp-api';

installSmirkPageApi();
```

After that, `window.smirk` exists in three contexts with the same shape:
- the v0.2.x browser extension (content script installs it before your code runs)
- the v0.3.0 desktop wallet's embedded browser (iframe + postMessage transport)
- the v0.4 mobile wallet's embedded browser (Capacitor bridge — same call signature)

All existing v0.2.x dapp code that uses `window.smirk.connect()`, `signMessage()`, `requestPayment()`, etc. continues to work everywhere. You do not have to choose a transport — `installSmirkPageApi()` picks the right one automatically.

## Why the change

v0.2.x ships only as a browser extension. The extension's content script injects `window.smirk` into every tab the user visits, so a dapp's only job is to feature-detect.

v0.3.0 introduces a **standalone desktop wallet** (Tauri-based, AppImage on Linux, .dmg on macOS, .msi on Windows). The desktop wallet has its own **embedded browser** where users navigate to dapps — much like MetaMask Mobile's in-app browser. There is no content script in that context; the wallet has to bridge `window.smirk` into the embedded page some other way.

v0.4 will add the Capacitor mobile wallet with its own in-app browser using the same bridge pattern.

Three transports, one API. The `@smirk/dapp-api` package abstracts the difference.

## How transport detection works

`installSmirkPageApi()` runs synchronously on page load. In order:

1. **Already-injected check.** If `window.smirk` is already defined, the extension content script ran first. We leave it alone. v0.2.x dapps in the user's regular browser see no change.
2. **Parent-frame check.** If `window.parent !== window`, the page is iframed by something. The wallet's `IframeBrowserController` (Linux desktop today, all desktop platforms in v0.3.x, mobile in v0.4) embeds dapp pages this way. We install a `window.smirk` whose every method posts a `SMIRK_REQUEST` envelope to `window.parent` and resolves on the matching response.
3. **Otherwise.** No extension, no iframe — `window.smirk` stays undefined. Your existing "install Smirk" fallback UI applies.

The detection is opt-in: dapps that haven't migrated to v0.3.0 keep working in the extension context and present "extension not found" to the v0.3.0 desktop user. Calling `installSmirkPageApi()` is what enables the iframe path.

## Migration checklist for an existing v0.2.x dapp

If you already use `window.smirk` (smirk.cash, play.wowne.ro, etc.):

- [ ] Add `@smirk/dapp-api` to your dependencies. The package has zero runtime deps beyond `window.parent.postMessage` so it's safe in any environment.
- [ ] Call `installSmirkPageApi()` once near the top of your client bundle (Next.js `app/layout.tsx`, Vite `main.ts`, similar).
- [ ] No changes required to your existing `window.smirk.connect()` / `signMessage()` / etc. code. The surface is identical.
- [ ] Update any "Smirk extension not found" UI to mention "or open this page in the Smirk desktop wallet" — both contexts are now first-class.

That's the entire diff. The total integration is a handful of lines.

## Authoring a new dapp from scratch

Same as v0.2.x: see the [`window.smirk` API reference](https://github.com/Such-Software/smirk-extension/blob/main/docs/INTEGRATION.md#api-reference) in the legacy doc. Plus `installSmirkPageApi()` at the top. No additional changes.

## Wire-format internals (background only — most dapps don't need this)

When the iframe transport runs, every call is a `SMIRK_REQUEST` envelope posted to `window.parent`:

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

The wallet's `IframeBrowserContent` listens for messages tagged with `channel: "smirk:dapp"`, dispatches the request through its `WalletHandler` (same handler the extension SW uses), and posts back:

```jsonc
{
  "channel": "smirk:dapp",
  "payload": {
    "type": "SMIRK_RESPONSE",
    "v": 1,
    "id": 7,
    "result": { ... }   // or "error": { "code": "...", "message": "..." }
  }
}
```

The `id` is per-request, allocated by the page side, and used to match each response to its caller. The protocol version (`v`) is 1 today and incremented on breaking changes. `installSmirkPageApi()` hides all of this — you only need to know it exists when debugging.

## Privacy posture

The integration is built so that **Smirk's infrastructure is never on the network path between your dapp and the user**. The page-side bundle ships from your domain (you `npm install @smirk/dapp-api`), there is no CDN we host, and the wallet itself runs locally on the user's device. The user's IP / referer / user-agent never touch Smirk-controlled servers as a result of calling `window.smirk.*`.

This is a hard architectural commitment, not a setting. We don't run a `cdn.smirk.cash` script tag because that would put us in the middle of every dapp's page load on every Smirk user.

## Compatibility matrix

| Dapp behaviour                                                                                       | v0.2.x browser extension | v0.3.0 desktop embedded browser | v0.4 mobile embedded browser |
| ---------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- | ---------------------------- |
| Dapp ships `installSmirkPageApi()` + uses `window.smirk`                                             | works                    | works                           | works                        |
| Legacy dapp uses `window.smirk` only (no `installSmirkPageApi()` call)                               | works                    | shows "wallet not found"        | shows "wallet not found"     |
| Dapp uses `installSmirkPageApi({ mode: 'never' })`                                                   | works (extension wins)   | shows "wallet not found"        | shows "wallet not found"     |
| Dapp uses `installSmirkPageApi({ mode: 'force' })` (testing — install even when not in Smirk iframe) | works (extension wins)   | works                           | works                        |

## Where to file issues

- v0.2.x extension behavior — [smirk-extension/issues](https://github.com/Such-Software/smirk-extension/issues)
- v0.3.0 desktop / monorepo / `@smirk/dapp-api` — [smirk-monorepo/issues](https://github.com/Such-Software/smirk-monorepo/issues)
- Integration questions / new transport requests — same issue tracker; tag `dapp-integration`.
