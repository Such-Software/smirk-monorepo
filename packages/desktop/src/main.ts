/**
 * Smirk Wallet desktop entry point.
 *
 * Install order is load-bearing:
 *  1. Install `chrome.*` shim FIRST — the popup's module top-level
 *     code calls `chrome.storage.local.get(...)` etc. at import time,
 *     so a `chrome` global must already exist before we dynamic-import
 *     the popup module.
 *  2. Dynamic-import the popup. This runs the popup's mount logic
 *     against our shimmed globals; the wallet UI takes over from
 *     there.
 *
 * No code-splitting in this entry — keep it under 100 LOC so a future
 * reader can follow the hand-off in one read.
 */

import { installChromeShim } from './chrome-shim';

installChromeShim();

// The popup lives in `@smirk/extension`. Vite resolves the workspace
// alias to its source `index.tsx`, which mounts the wallet via
// `render(<App />, root)` at module evaluation. Catch any throw so
// we can show a recovery hint instead of a blank window.
async function boot(): Promise<void> {
  try {
    await import('@smirk/extension/popup');
  } catch (e) {
    console.error('[smirk-desktop] Failed to boot wallet UI:', e);
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `
        <div style="
          padding: 32px;
          font-family: -apple-system, system-ui, sans-serif;
          color: #f5f5f5;
          background: #0e0e10;
          height: 100vh;
        ">
          <h1 style="margin-top: 0;">Smirk Wallet — startup error</h1>
          <p>The wallet UI failed to load. Details in the developer console.</p>
          <pre style="
            background: rgba(255,255,255,0.05);
            padding: 12px;
            border-radius: 6px;
            overflow: auto;
            font-size: 12px;
          ">${e instanceof Error ? e.stack ?? e.message : String(e)}</pre>
        </div>
      `;
    }
  }
}

void boot();
