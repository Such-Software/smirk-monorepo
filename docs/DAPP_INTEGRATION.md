# Integrating Smirk into Your Dapp

A guide for websites, web games, and login systems that want users to authenticate or pay with their Smirk wallet. Covers the v0.2.x browser extension surface that already exists on play.wowne.ro / smirk.cash, the v0.3.0 desktop wallet's embedded browser, and the planned v0.4 Capacitor mobile surface.

Companion to the v0.2.x [legacy integration guide](https://github.com/Such-Software/smirk-extension/blob/main/docs/INTEGRATION.md) — that doc still applies for everything that targets the browser extension. This guide describes what changed in v0.3.0 and how to support both old and new wallet shapes from the same codebase.

## The short version

Add this near the top of your page bundle:

```ts
import { installSmirkPageApi } from '@such-software/smirk-dapp-api';

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

Three transports, one API. The `@such-software/smirk-dapp-api` package abstracts the difference.

## How transport detection works

`installSmirkPageApi()` runs synchronously on page load. In order:

1. **Already-injected check.** If `window.smirk` is already defined, the extension content script ran first. We leave it alone. v0.2.x dapps in the user's regular browser see no change.
2. **Parent-frame check.** If `window.parent !== window`, the page is iframed by something. The wallet's `IframeBrowserController` (Linux desktop today, all desktop platforms in v0.3.x, mobile in v0.4) embeds dapp pages this way. We install a `window.smirk` whose every method posts a `SMIRK_REQUEST` envelope to `window.parent` and resolves on the matching response.
3. **Otherwise.** No extension, no iframe — `window.smirk` stays undefined. Your existing "install Smirk" fallback UI applies.

The detection is opt-in: dapps that haven't migrated to v0.3.0 keep working in the extension context and present "extension not found" to the v0.3.0 desktop user. Calling `installSmirkPageApi()` is what enables the iframe path.

## Migration checklist for an existing v0.2.x dapp

If you already use `window.smirk` (smirk.cash, play.wowne.ro, etc.):

- [ ] Add `@such-software/smirk-dapp-api` to your dependencies. The package has zero runtime deps beyond `window.parent.postMessage` so it's safe in any environment.
- [ ] Call `installSmirkPageApi()` once near the top of your client bundle (Next.js `app/layout.tsx`, Vite `main.ts`, similar).
- [ ] No changes required to your existing `window.smirk.connect()` / `signMessage()` / etc. code. The surface is identical.
- [ ] Update any "Smirk extension not found" UI to mention "or open this page in the Smirk desktop wallet" — both contexts are now first-class.

That's the entire diff. The total integration is a handful of lines.

## Authoring a new dapp from scratch

Same as v0.2.x: see the [`window.smirk` API reference](https://github.com/Such-Software/smirk-extension/blob/main/docs/INTEGRATION.md#api-reference) in the legacy doc. Plus `installSmirkPageApi()` at the top. No additional changes.

## Sign in with Nostr (NIP-98)

Since `@such-software/smirk-dapp-api` 0.4.0, a dapp can authenticate a user with their wallet's **seed-derived Nostr identity** — the same npub the wallet uses to sign in to its own backend (NIP-06 derivation, schnorr/BIP-340). No passwords, no email, no Smirk servers in the loop: the dapp gets a stable public key and a signature it verifies itself.

Two methods (both flat on `window.smirk`):

```ts
// The user's Nostr public key (32-byte x-only, hex). Prompts a one-time
// per-origin "allow this site to see your Nostr identity" approval.
const pubkey: string = await window.smirk.getNostrPublicKey();

// Ask the wallet to sign a NIP-01 event. The wallet stamps created_at (if
// omitted), pubkey, the event id, and the schnorr signature.
const signed = await window.smirk.signNostrEvent({
  kind: 27235,            // NIP-98 HTTP auth
  content: '',
  tags: [
    ['u', 'https://your-dapp.example/api/login'],
    ['method', 'POST'],
  ],
});
// signed: { id, pubkey, kind, content, tags, created_at, sig }
```

A minimal login:

1. Your server issues a challenge (or you rely on the NIP-98 `u`/`method`/`payload` tags for the specific request being authenticated).
2. The page builds the unsigned event and calls `window.smirk.signNostrEvent(...)`.
3. Send the signed event to your server; verify the schnorr signature over the NIP-01 id against `signed.pubkey`, and check the tags match the request (and `created_at` is fresh). A valid signature proves the user controls that npub.

`signNostrEvent` is general-purpose NIP-01 — kind 27235 for NIP-98 auth, kind 1 for a note your dapp publishes on the user's behalf, etc. The private key never leaves the wallet; the page only ever receives the signed event.

**Version gate — feature-detect.** The Nostr identity is a **v0.3+** feature: the v0.2.x extension has no npub, so `getNostrPublicKey` / `signNostrEvent` are absent (or reject) there. Guard before using them:

```ts
if (typeof window.smirk?.getNostrPublicKey === 'function') {
  // offer "Sign in with Nostr"
}
```

`getBackend()` (also 0.4.0) returns the backend URL the user's wallet is pointed at, so a self-sovereign dapp can adapt to a user who runs their own Smirk backend.

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

The integration is built so that **Smirk's infrastructure is never on the network path between your dapp and the user**. The page-side bundle ships from your domain (you `npm install @such-software/smirk-dapp-api`), there is no CDN we host, and the wallet itself runs locally on the user's device. The user's IP / referer / user-agent never touch Smirk-controlled servers as a result of calling `window.smirk.*`.

This is a hard architectural commitment, not a setting. We don't run a `cdn.smirk.cash` script tag because that would put us in the middle of every dapp's page load on every Smirk user.

## Compatibility matrix

The **v0.3.0 browser extension** (the monorepo build now shipping to the stores)
injects `window.smirk` from its content script exactly like v0.2.x, so the
already-injected path covers it. Unlike v0.2.x it carries a seed-derived Nostr
identity, so `getNostrPublicKey()` / `signNostrEvent()` work there too.

| Dapp behaviour                                                                                       | v0.2.x browser extension | v0.3.0 browser extension | v0.3.0 desktop embedded browser | v0.4 mobile embedded browser |
| ---------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------ | ------------------------------- | ---------------------------- |
| Dapp ships `installSmirkPageApi()` + uses `window.smirk`                                             | works                    | works                    | works                           | works                        |
| Legacy dapp uses `window.smirk` only (no `installSmirkPageApi()` call)                               | works                    | works                    | shows "wallet not found"        | shows "wallet not found"     |
| Dapp uses `installSmirkPageApi({ mode: 'never' })`                                                   | works (extension wins)   | works (extension wins)   | shows "wallet not found"        | shows "wallet not found"     |
| Dapp uses `installSmirkPageApi({ mode: 'force' })` (testing: install even when not in Smirk iframe) | works (extension wins)   | works (extension wins)   | works                           | works                        |
| Dapp uses `getNostrPublicKey()` / `signNostrEvent()` (Sign in with Nostr, dapp-api ≥ 0.4.0)          | not available (no npub)  | works                    | works                           | works                        |

## Where to file issues

- v0.2.x extension behavior — [smirk-extension/issues](https://github.com/Such-Software/smirk-extension/issues)
- v0.3.0 desktop / monorepo / `@such-software/smirk-dapp-api` — [smirk-monorepo/issues](https://github.com/Such-Software/smirk-monorepo/issues)
- Integration questions / new transport requests — same issue tracker; tag `dapp-integration`.
