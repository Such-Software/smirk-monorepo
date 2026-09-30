/**
 * Smirk Wallet desktop entry point.
 *
 * Install order is load-bearing:
 *  1. Install `chrome.*` shim FIRST: the popup's module top-level
 *     code calls `chrome.storage.local.get(...)` etc. at import time,
 *     so a `chrome` global must already exist before we dynamic-import
 *     the popup module.
 *  2. Install the embedded-browser controller on
 *     `globalThis.__smirk_browser__`. The popup's BottomNav surfaces
 *     a Browse tab only when this global is present, which keeps
 *     the extension build's UI untouched.
 *  3. Install native HTTP for swaps, then dynamic-import the popup.
 *     This runs the popup's mount logic
 *     against our shimmed globals; the wallet UI takes over from
 *     there.
 *
 * No code-splitting in this entry: keep it under 100 LOC so a future
 * reader can follow the hand-off in one read.
 */

import { getPageApiInjectionScript } from '@such-software/smirk-dapp-api';
import {
  IframeBrowserController,
  type DappBrowserController,
} from '@smirk/dapp-browser';

import { installChromeShim } from './chrome-shim';
import { installDesktopHttp } from './native-http';
import { showStartupError, type StartupStage } from './startup-error';
import {
  TauriBrowserController,
  TAURI_DAPP_RPC_EVENT,
} from './dapp/tauri-browser-controller';

installChromeShim();

/**
 * Linux desktop uses an iframe-backed controller; macOS / Windows
 * use the native Tauri WebviewWindow path. The split exists because
 * WebKitGTK on X11 loses its compositor surface on parent-window
 * resize (tauri-apps/tauri#7537, tauri-apps/wry#1727), leaving the
 * embedded WebView black until the tab is destroyed. WKWebView
 * (macOS) and WebView2 (Windows) don't have this failure mode, so
 * they keep the canonical "native WebView per tab" architecture
 * that other wallets (MetaMask, Phantom) use on mobile.
 *
 * `navigator.userAgent` is the runtime platform signal at hand;
 * Tauri's `os` plugin would be cleaner but pulls in another command
 * roundtrip + capability. The UA-string check is fine here because
 * we run in our own WebView; UA spoofing isn't a threat surface.
 */
function isLinuxDesktop(): boolean {
  return /\bLinux\b/i.test(navigator.userAgent);
}

async function installTauriController(): Promise<TauriBrowserController> {
  const controller = new TauriBrowserController();
  try {
    const script = getPageApiInjectionScript({
      transport: { kind: 'tauri', event: TAURI_DAPP_RPC_EVENT },
    });
    await controller.setInitScripts([script]);
  } catch {
    console.warn('[smirk-desktop] Browser wallet provider could not be installed.');
  }
  return controller;
}

function installIframeController(): IframeBrowserController {
  // The iframe controller is in-process JS: no Tauri command
  // round-trip needed. Page-side script injection is the dapp's
  // responsibility (cross-origin iframes block parent injection);
  // see docs/DAPP_INTEGRATION.md.
  return new IframeBrowserController({ homeUrl: 'https://smirk.cash' });
}

async function installBrowserController(): Promise<void> {
  const controller: DappBrowserController = isLinuxDesktop()
    ? installIframeController()
    : await installTauriController();
  (globalThis as { __smirk_browser__?: DappBrowserController }).__smirk_browser__ =
    controller;
}

// The popup lives in `@smirk/extension`. Vite resolves the workspace
// alias to its source `index.tsx`, which mounts the wallet via
// `render(<App />, root)` at module evaluation. Catch any throw so
// we can show a recovery hint instead of a blank window.
async function boot(): Promise<void> {
  let stage: StartupStage = 'native HTTP';
  try {
    installDesktopHttp();
    stage = 'browser services';
    await installBrowserController();
    stage = 'wallet interface';
    await import('@smirk/extension/popup');
  } catch {
    console.error(`[smirk-desktop] Startup failed at ${stage}.`);
    const root = document.getElementById('root');
    if (root) showStartupError(root, stage);
  }
}

void boot();
