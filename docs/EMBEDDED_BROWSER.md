# Embedded browser architecture

A guide for contributors adding to or implementing Smirk's in-app
browser. The Tauri desktop implementation ships in v0.3.0; the
Capacitor mobile (iOS / Android) implementation is planned for v0.4
and will reuse everything in this document except the
platform-specific controller.

This document explains the layered architecture, the package boundaries,
the contracts between layers, and the conventions every contributor is
expected to follow when adding new code in this surface.

If you're new to the codebase, read this end-to-end before opening a
PR. The architecture is small but it depends on each layer staying
inside its lane; drift is what introduces spaghetti.

## TL;DR

Smirk's embedded browser is built from two **orthogonal** packages and
a UI component library that consumes them:

| Package                  | Question it answers                                          |
| ------------------------ | ------------------------------------------------------------ |
| `@such-software/smirk-dapp-api`        | How does a webpage talk to a wallet?                         |
| `@smirk/dapp-browser`    | How does an app embed a browseable web surface?              |
| `@smirk/ui` (browser/)   | What does the URL bar / tab strip / chrome look like?        |

Each platform shell (`packages/desktop`, `packages/mobile`) implements
the `DappBrowserController` interface and wires the platform-specific
transport between embedded webview and wallet handler. The UI shell
and the controller interface are platform-agnostic.

The extension does **not** use `dapp-browser`: the host browser IS
the browser there. The extension uses only `@such-software/smirk-dapp-api`.

## Layered architecture

```
                    ┌─────────────────────────────────────┐
   shared UI        │  @smirk/ui/components/browser/      │
                    │    BrowserShell  / BrowserUrlBar    │
                    │    BrowserTabStrip                  │
                    └────────────────┬────────────────────┘
                                     │ consumes (props)
                                     ▼
                    ┌─────────────────────────────────────┐
   shared controller│  @smirk/dapp-browser                │
   interface +      │    DappBrowserController interface  │
   pure data        │    BrowserNavigationState           │
   types            │    BrowserTab, BrowserFrameRect     │
                    │    HistoryStore, BookmarkStore      │
                    │    MockController (tests / dev)     │
                    └───────────┬─────────────┬───────────┘
                                │ impl        │ impl
                                ▼             ▼
              ┌──────────────────────┐  ┌──────────────────────┐
              │ TauriBrowserCtrl     │  │ CapacitorBrowserCtrl │
              │ (packages/desktop)   │  │ (packages/mobile)    │
              │  + Rust plugin       │  │  + Swift plugin      │
              │  (browser_plugin.rs) │  │  + Kotlin plugin     │
              └──────────┬───────────┘  └──────────┬───────────┘
                         │ creates                 │ creates
                         ▼                         ▼
              ┌──────────────────────┐  ┌──────────────────────┐
              │ Tauri WebviewWindow  │  │ Native WKWebView     │
              │  per tab             │  │ / Android WebView    │
              │  + init script       │  │  per tab             │
              │                      │  │  + injected script   │
              └──────────┬───────────┘  └──────────┬───────────┘
                         │ wallet RPC              │ wallet RPC
                         ▼                         ▼
                    ┌───────────────────────────────────────────────────┐
   wallet handling  │  @such-software/smirk-dapp-api                    │
   (unchanged)      │    installSmirkApi (page side)                    │
                    │    createWalletHandler (wallet side)              │
                    │    protocol / permissions / approval              │
                    └───────────────────────────────────────────────────┘
```

## Package boundaries: what belongs where

The cardinal rule: each package answers **one** question. If you're
unsure where a new file belongs, identify which question it answers.

### `@such-software/smirk-dapp-api`: wallet RPC

Answers: *"How does a webpage talk to a wallet?"*

Contains:

- Wire-protocol types (`SmirkWireRequest`, `SmirkWireResponse`)
- `installSmirkApi(window, transport)`: page-side
- `createWalletHandler(deps)`: wallet-side dispatcher
- `WalletProvider`, `ApprovalHandler`, `OriginPermissionStore` interfaces
- `getPageApiInjectionScript()`: returns the script source string
  that browser controllers can inject into new webviews

Does **not** contain:

- Anything about how pages are rendered (no webviews, no DOM, no UI)
- Anything platform-specific (no `chrome.*`, no `WKWebView`, no Tauri)

### `@smirk/dapp-browser`: embedded browser shell

Answers: *"How does an app embed a browseable web surface?"*

Contains:

- `DappBrowserController` interface (the platform-impl seam)
- `BrowserNavigationState`, `BrowserTab`, `BrowserFrameRect` types
- `HistoryStore`, `BookmarkStore` interfaces + in-memory defaults
- `MockController` for tests, Storybook, and headless development

Does **not** contain:

- Wallet RPC (use `@such-software/smirk-dapp-api`)
- UI components (use `@smirk/ui`)
- Platform implementations (use `packages/desktop`, `packages/mobile`)

### `@smirk/ui/components/browser/`: visual chrome

Answers: *"What does the URL bar / tab strip / chrome look like?"*

Contains:

- `BrowserShell`: composes URL bar + tab strip + frame area
- `BrowserUrlBar`, `BrowserTabStrip`, `IframeBrowserContent`
- React props are typed against `DappBrowserController` (the interface,
  not any specific implementation)

Does **not** contain:

- Platform code (works against any controller impl, including
  `MockController` for dev)

### `packages/desktop`, `packages/mobile`: composition + native glue

The wallet shells:

1. Construct a `DappBrowserController` impl
2. Wire `installSmirkApi`'s script into the controller via
   `controller.setInitScripts([dappApiScript])`
3. Wire the platform's IPC transport into a `walletHandler.dispatch`
4. Pass the controller to `BrowserShell` as a prop

Each platform owns ~30 lines of dispatcher code (transport-specific)
and the controller impl (webview management). Nothing else.

## How the layers connect

The connection is made in the wallet shell, not in either package.
This is intentional: keeps `dapp-browser` ignorant of `dapp-api`, and
`dapp-api` ignorant of any browser.

```ts
// Wallet shells compose dapp-browser + dapp-api at the boundary.
// Today the desktop shell does this against `TauriBrowserController`
// in packages/desktop/src/dapp/tauri-browser-controller.ts; the
// future mobile shell will mirror the shape against a
// `CapacitorBrowserController`.
import { getPageApiInjectionScript, createWalletHandler, type SmirkWireRequest } from '@such-software/smirk-dapp-api';
import { TauriBrowserController, TAURI_DAPP_RPC_EVENT } from './tauri-browser-controller';

const browserController = new TauriBrowserController();
const pageApiScript = getPageApiInjectionScript({
  transport: { kind: 'tauri', event: TAURI_DAPP_RPC_EVENT },
});
await browserController.setInitScripts([pageApiScript]);

const handler = createWalletHandler({ provider, permissions, approval });

// Platform-specific dispatcher: ~30 LOC.
// Hooks the page's `window.smirk.X()` postMessage → walletHandler.dispatch.
browserController.setPageRequestHandler(async ({ request, origin }) => {
  return await handler(request as SmirkWireRequest, { origin });
});
```

The browser controller knows how to inject a string and how to forward
page messages. `dapp-api` exports the string and the handler. The glue
between them is small, in one place, easy to audit.

## Webview positioning

Embedded webviews are **native OS-level objects**: `WKWebView` on iOS,
Android `WebView`, `WebKitGTK`, etc. They cannot be embedded as DOM
elements inside our React/Preact UI tree. We have to position them as
overlays over the wallet UI by absolute coordinates.

The pattern:

1. `BrowserShell` renders the chrome (URL bar, tabs, status). It leaves
   a "frame area" empty.
2. `BrowserShell` measures the frame area's bounding rect and calls
   `controller.setFrameRect(rect)`.
3. The controller positions the native webview at those coordinates.
4. On resize or layout change, `BrowserShell` re-measures and re-calls
   `setFrameRect`.

The webview floats over the UI rendering. Our UI never sees the web
content directly.

## Multi-tab from day 1

The interface is tab-scoped from the beginning, even though some
controllers may ship with single-tab impls.

```ts
interface DappBrowserController {
  newTab(url?: string): Promise<TabId>;
  closeTab(id: TabId): Promise<void>;
  switchTab(id: TabId): Promise<void>;
  listTabs(): Promise<readonly BrowserTab[]>;
  activeTab(): Promise<TabId>;

  navigate(url: string, tab?: TabId): Promise<void>;
  goBack(tab?: TabId): Promise<void>;
  goForward(tab?: TabId): Promise<void>;
  reload(tab?: TabId): Promise<void>;
}
```

Single-tab impls always allocate exactly one tab; `newTab` either
returns the existing tab id or throws `NotSupportedError`. The UI
treats one-tab and many-tab the same way: `BrowserTabStrip` collapses
itself when only one tab is present.

This avoids the trap of bolting on multi-tab later and having to
rewrite the UI.

## What ships when

| Layer                                    | v0.3.0 desktop | v0.4 mobile | v0.4+ polish |
| ---------------------------------------- | -------------- | ----------- | ------------ |
| `@such-software/smirk-dapp-api` (already shipped)      | unchanged      | unchanged   | -            |
| `@smirk/dapp-browser` types + interface  | ship           | ship        | -            |
| `BrowserShell` + sub-components          | ship           | ship        | -            |
| `TauriBrowserController` + Rust plugin   | ship           | -           | -            |
| Capacitor iOS plugin + controller        | -              | ship        | -            |
| Capacitor Android plugin + controller    | -              | ship        | -            |
| Multi-tab UI polish                      | -              | -           | v0.4+        |
| Bookmarks persistence                    | -              | -           | v0.4+        |
| History persistence + autocomplete       | -              | -           | v0.4+        |

**v0.3.0 desktop browser architecture.** Each browser tab is a
borderless Tauri `WebviewWindow` positioned over the wallet's
`<BrowserShell>` frame slot, with `install_window_follow()` in the
plugin keeping the active tab glued to the wallet on Move/Resize/
Focus events. We tried the multi-webview-per-window API
(`Window::add_child`, gated behind Tauri's `unstable` feature)
first but wry packs `add_child`'d webviews into the parent's
`GtkBox` on Linux/WebKitGTK, silently ignoring our positioning.
The stable per-tab `WebviewWindow` approach gives pixel-perfect
positioning on macOS and Windows.

Linux takes a second path. WebKitGTK loses its compositor surface on
parent-window resize (tauri-apps/tauri#7537, tauri-apps/wry#1727) and
paints the embedded WebView black until the tab is destroyed, so Linux
runs `IframeBrowserController`, which renders one `<iframe>` per tab
inside the wallet webview. `packages/desktop/src/main.ts` picks the
controller at boot.

## Conventions

These apply throughout this surface. They're not aspirational: PRs
that violate them get sent back. They exist because this code is
public-facing and read by people who didn't write it.

### Naming

- **Types and interfaces**: PascalCase. Suffix with `Controller`,
  `Provider`, `Handler`, `Store`, `Adapter`, `Strategy` for pluggable
  contracts. E.g. `DappBrowserController`, `HistoryStore`.
- **Functions**: camelCase, verb-first. E.g. `createWalletHandler`,
  `installSmirkApi`, `getPageApiInjectionScript`.
- **Files**: kebab-case matching the canonical export. E.g.
  `tauri-browser-controller.ts` exports `TauriBrowserController`.
- **Constants**: SCREAMING_SNAKE_CASE for module-level; camelCase
  inline.
- **Type vs interface**: prefer `interface` for contracts (extensible
  by consumers), `type` for shape-only data (no extension semantics).
- **Branded primitives**: opaque newtypes around primitive values
  (e.g. `TabId = string & { readonly __tag: 'TabId' }`) where
  cross-domain mixing would be a category error.

### Commenting

- **JSDoc on every exported symbol.** Even if the name is
  self-explanatory, include the *why*: what problem this exists to
  solve, what surprising trade-offs were made.
- **Inline comments are for the why, never the what.** Code already
  says what it does; comments explain rationale, edge cases, prior
  incidents, and unsurprising-but-non-obvious choices.
- **Cite specific file paths and line numbers** when referencing other
  code. Format: `path/to/file.ts:42` (linkable in most IDEs).
- **No emoji in code or comments.** Slack, GitHub issues, release
  notes: fine. Source files, no.
- **No undated TODOs.** Every TODO either has an owner
  `// TODO(@username):` or an issue link `// TODO(#123):`. Otherwise
  it's a comment, not a TODO, and don't tag it as one.
- **Section dividers** using a 70-char-wide `// ====` line for long
  files. Use sparingly: a file long enough to need dividers is
  usually long enough to split.

### Module organization

- **One concept per file.** A file named `controller.ts` exports one
  controller interface. Don't pile unrelated stuff in.
- **Re-export from `index.ts`.** Each package has exactly one entry,
  `src/index.ts`, that re-exports the public surface. Internal types
  are not re-exported.
- **Tests live in `src/__tests__/`.** One file per module under test
  (`controller.ts` → `__tests__/controller.test.ts`), plus shared
  suites such as `__tests__/conformance.ts`.

### Error handling

- **Define a named error type per recoverable failure mode.**
  `NotSupportedError`, `WebviewNotReadyError`, `OriginNotAllowedError`,
  etc. Generic `Error` instances are only for genuinely unexpected
  failures.
- **Async functions throw, sync functions return `Result`-shaped
  unions where appropriate.** No mixing within one module.

### Platform parity

- **Same interface, different impls.** Never branch on platform inside
  a controller method body: that's a sign the interface is leaking.
  If you find yourself writing `if (isTauri) ... else if (isCapacitor)`
  inside a controller method, refactor.
- **Same behaviour at the API surface.** A `controller.navigate(url)`
  on desktop must produce the same observable result as on mobile,
  modulo platform constraints. Document those constraints in the
  interface JSDoc.

## Reading order for new contributors

1. This document.
2. `packages/dapp-api/README.md` (existing).
3. `packages/dapp-browser/README.md`.
4. `packages/dapp-browser/src/controller.ts`: the interface.
5. `packages/dapp-browser/src/mock-controller.ts`: a complete impl
   small enough to read in 5 minutes.
6. `packages/ui/src/components/browser/BrowserShell.tsx`: how the UI
   consumes the controller.
7. Platform impls: pick desktop or mobile depending on which you're
   touching.

## License

MIT OR Apache-2.0: matches the rest of the monorepo.
