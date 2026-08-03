# @smirk/dapp-browser

Embedded-browser shell abstraction for Smirk Wallet's desktop (Tauri)
and mobile (Capacitor) builds.

This package answers exactly one question:

> How does an app embed a browseable web surface with multiple tabs,
> navigation, and the ability to inject a wallet-RPC script?

It does **not** know anything about wallets, signatures, or the
`window.smirk` API. Wallet RPC lives in `@such-software/smirk-dapp-api`.

If you're new to the codebase, read
[docs/EMBEDDED_BROWSER.md](../../docs/EMBEDDED_BROWSER.md) first.

## Install

This is a workspace package; consumers depend on it via `*` in their
`package.json`:

```jsonc
{
  "dependencies": {
    "@smirk/dapp-browser": "*"
  }
}
```

## 30-second tour

```ts
import { MockController } from '@smirk/dapp-browser';

const browser = new MockController({ homeUrl: 'https://smirk.cash' });

await browser.setInitScripts([myInjectionScript]);
await browser.open();

const unsubscribe = browser.subscribe((snap) => {
  console.log('active:', snap.activeState.url, 'tabs:', snap.tabs.length);
});

await browser.newTab('https://example.com');
await browser.navigate('https://duckduckgo.com');

unsubscribe();
await browser.close();
```

In production code, swap `MockController` for `TauriBrowserController`
(desktop, in `@smirk/desktop`), `IframeBrowserController` (shipped
here, used on Linux desktop), or `CapacitorBrowserController` (mobile,
planned v0.4). The interface is the same.

## Public surface

| Symbol | What it is |
| ------ | ---------- |
| `DappBrowserController` | The interface every platform implementation satisfies. |
| `BrowserSnapshot` | Shape consumed by subscribers: active tab, full tab list, and pre-extracted active state. |
| `BrowserNavigationState` | URL, title, loading, can-go-back/forward, favicon, origin, security indicator. |
| `BrowserTab`, `TabId` | Tab metadata + branded id. |
| `BrowserFrameRect` | x/y/width/height for positioning the native webview overlay. |
| `PageRequest`, `PageRequestHandler` | Wire-format request from an embedded page + the wallet-side handler signature. |
| `HistoryStore`, `InMemoryHistoryStore` | Persistence interface + default in-memory impl. |
| `BookmarkStore`, `InMemoryBookmarkStore` | Same shape for bookmarks. |
| `MockController` | Headless `DappBrowserController` impl for tests and dev. |
| `IframeBrowserController`, `IframeControllerOptions`, `InlineModeController` | Iframe-backed impl for platforms where native-webview-per-tab is unreliable (Linux desktop). DOM-free itself; `@smirk/ui`'s `IframeBrowserContent` renders the iframes. |
| `NotSupportedError`, `UnknownTabError`, `makeTabId` | Named errors callers can branch on, plus the `TabId` brander. |

## Implementing a new controller

Subclassing isn't expected; the interface is the contract. A new
platform implementation is a class that satisfies
`DappBrowserController` against the platform's native APIs.

Required reading before you start:

1. The file header in `src/controller.ts` covers lifecycle invariants.
2. The `MockController` source (`src/mock-controller.ts`) is a
   complete reference implementation, short enough to read in five
   minutes. Mirror its shape.
3. The architecture doc's section on **webview positioning**:
   embedded webviews are native overlays positioned over the wallet
   UI by absolute coordinates, not iframes in the DOM. Your impl
   needs `setFrameRect(rect)` to actually move the native webview.

Conventions enforced in PR review:

- Every exported symbol has a JSDoc block.
- Comments explain *why*, not *what*.
- File names match the canonical export (kebab-case file → PascalCase
  type).
- Errors are named types (`MyConditionError extends Error`), not
  generic `Error("...")`.
- No emoji in source files.

The full conventions live in
[docs/EMBEDDED_BROWSER.md#conventions](../../docs/EMBEDDED_BROWSER.md#conventions).

## Testing

```sh
npm run typecheck -w @smirk/dapp-browser
npm run test -w @smirk/dapp-browser
```

Tests run under `node --test` (`node:test` + `node:assert/strict`) and
live in `src/__tests__/`. `conformance.ts` there exports the shared
`DappBrowserController` contract suite that every controller impl
runs, alongside impl-specific tests for `MockController` and
`IframeBrowserController`. A new impl adds its own file and calls the
conformance suite with a factory, so drift between impls is caught at
the test boundary.

## License

MIT OR Apache-2.0: matches the rest of the monorepo.
