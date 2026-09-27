# Embedded browser architecture

> Status: stable · Updated 2026-09-27 · Applies to: desktop embedded browser contributors

The v0.3.0 desktop source embeds dapp pages through native Tauri webviews on macOS
and Windows, and DOM iframes on Linux. The browser extension uses the user's
browser and does not mount this embedded browser. A Capacitor transport shape
exists in the dapp API package, but no mobile wallet shell or native mobile
browser controller is implemented in this repository.

This document owns the composition and trust boundaries. The
[dapp integration guide](DAPP_INTEGRATION.md) owns page installation and platform
API exposure. These are implementation claims, not evidence that a release has
passed native acceptance or reached a store.

## Layers and owners

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Wallet RPC | [dapp-api](../packages/dapp-api/README.md) | Protocol, page adapters, permission policy, approval dispatch |
| Browser controller | [dapp-browser](../packages/dapp-browser/README.md) | Navigation, tabs, frame placement, subscriptions, opaque page requests |
| Browser UI | [browser components](../packages/ui/src/components/browser) | URL bar, tab strip, frame slot, iframe rendering |
| Native desktop | [desktop entry](../packages/desktop/src/main.ts) and [Rust plugin](../packages/desktop/src-tauri/src/browser_plugin.rs) | Controller selection, webview lifecycle, native transport |
| Wallet composition | [Browse route](../packages/extension/src/popup/routes/browse.tsx) | Live wallet provider, permission store, approval queue, request bridge |

The controller interface has no wallet-specific method types. It forwards an
opaque request paired with its transport-derived origin and tab ID. The wallet
bridge validates that request before calling the dispatcher. UI components
depend on the controller interface rather than the native implementation.

```text
Desktop entry selects a controller
  macOS / Windows: TauriBrowserController -> Rust plugin -> native webview
  Linux: IframeBrowserController -> IframeBrowserContent -> DOM iframe
      |
      v
Browse route -> page-request bridge -> wallet dispatcher
                                    -> permission store
                                    -> approval queue and live wallet provider
```

## Controller contract

[DappBrowserController](../packages/dapp-browser/src/controller.ts) owns the full
interface. This excerpt shows the tab and navigation methods:

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

An omitted tab argument targets the active tab. `subscribe` supplies snapshots
for navigation, tab-list, and active-tab changes. `open` initializes browser
resources; `close` releases them. Frame methods position or hide the page surface.
The interface also supplies initialization scripts and a page-request handler,
but platform constraints determine what a controller can implement.

The Linux controller cannot inject JavaScript into a cross-origin document or
inspect that document's native history. Dapps install the iframe page adapter
themselves, and the controller tracks navigation initiated through the wallet.
A site can also refuse framing. Native and iframe controllers therefore do not
promise identical browser behavior.

## Native page bridge

The desktop entry configures a native controller before opening it:

```ts
import { getPageApiInjectionScript } from '@such-software/smirk-dapp-api';
import {
  TauriBrowserController,
  TAURI_DAPP_RPC_EVENT,
} from './dapp/tauri-browser-controller';

const controller = new TauriBrowserController();
await controller.setInitScripts([
  getPageApiInjectionScript({
    transport: { kind: 'tauri', event: TAURI_DAPP_RPC_EVENT },
  }),
]);
```

The wallet composition creates its provider, permissions, and approval queue,
then uses `createPageRequestBridge` to validate and dispatch page requests:

```ts
const dispatch = createWalletHandler({ provider, permissions, approval });
controller.setPageRequestHandler(createPageRequestBridge(dispatch));
```

See the [bridge source](../packages/extension/src/dapp-popup/page-bridge.ts) and
[Browse route](../packages/extension/src/popup/routes/browse.tsx) for the complete
composition. The Rust plugin resolves the requesting webview's current URL to an
origin and forwards the request to the main wallet window. Responses are routed
through the plugin to the originating webview.

The native injection script exposes the core dapp methods. It does not install
the extension's Nostr provider, app-encryption methods, `getBackend`,
`disconnect`, or `isConnected`. Shared dispatcher support does not expand that
page surface automatically.

## Linux iframe bridge

`IframeBrowserContent` renders the controller's tabs as iframes. Inactive tabs
remain mounted and hidden. Reloading or navigating changes the frame key so a
new document loads.

The page calls `installSmirkPageApi()` and sends requests to its parent through
`postMessage`. The wallet matches the browser-provided `event.source` to a
frame it owns and uses `event.origin` as the requesting origin. Replies target
the same source and origin. The page adapter accepts responses only from its
parent and, if configured, the expected wallet origin.

The iframe is not a sandbox for untrusted scripts. Pages retain their own script,
cookie, and navigation behavior. The wallet's origin permissions and operation
approvals control access to wallet operations. Do not grant wallet authority
based on a page-supplied origin or on a frame merely being present.

## Frame placement and approvals

Native webviews sit outside the wallet's DOM tree. `BrowserShell` measures its
frame slot and calls `setFrameRect` as layout changes. The native controller
positions the page over that slot. On Linux, the iframe occupies the slot as a
DOM element.

A native page could cover a wallet approval modal if left visible. The Browse
route hides the page while an approval is pending, then triggers frame placement
again after the decision. Its approval queue permits one pending request and
refuses concurrent requests.

The live provider reads current wallet state when an operation runs. Private
operations check that the captured wallet session is still active after
asynchronous authorization and before signing. Explicit lock and the unlock
deadline revoke that session. A remembered origin grant cannot restore it.
Optional password confirmation applies without extending the existing deadline.

## Verification boundaries

Shared tests can verify controller state, bridge validation, origin permissions,
and approval behavior. Native acceptance must additionally verify webview
placement, navigation, response routing, and modal visibility on each supported
OS. An iframe test cannot establish native-webview behavior.

Mobile implementation, broader injected API exposure, and browser feature parity
require their own code and acceptance evidence. Keep them marked as planned until
that evidence exists. The [desktop package](../packages/desktop/README.md) owns
platform build and packaging instructions.

## Reusable change checklist

- [ ] Kept navigation separate from wallet method and permission policy.
- [ ] Bound each request to a transport-derived origin and the originating tab.
- [ ] Tested malformed requests, missing permission, user denial, and lock during approval.
- [ ] Preserved modal visibility and page hiding on native webviews.
- [ ] Verified the changed controller on its actual platform.
- [ ] Updated page-exposure documentation without promising unimplemented parity.
