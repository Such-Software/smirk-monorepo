/**
 * A `fetch` that is not subject to the webview's CORS rules, when one exists.
 *
 * The swap provider (api.trocador.app) sends no `Access-Control-Allow-Origin`
 * for a `tauri://` origin, so a plain webview fetch from the desktop app is
 * refused and the user sees "Load failed" the moment they ask for a quote. The
 * extension never hit this: it declares `<all_urls>` host permissions, which
 * bypasses CORS, so the same code worked there and only desktop was broken.
 *
 * The desktop entry point installs its bundled HTTP plugin before mounting
 * the popup. The extension keeps using browser fetch and has no Tauri import.
 */
let desktopFetch: typeof fetch | undefined;

/** Called by the desktop shell before importing the shared popup. */
export function installNativeFetch(fetchImpl: typeof fetch): void {
  desktopFetch = fetchImpl;
}

export function nativeFetch(): typeof fetch | undefined {
  if (!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return undefined;
  }
  if (!desktopFetch) {
    throw new Error('The desktop swap connection did not start. Restart Smirk and try again.');
  }
  return desktopFetch;
}
