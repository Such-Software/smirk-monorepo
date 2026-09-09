/**
 * A `fetch` that is not subject to the webview's CORS rules, when one exists.
 *
 * The swap provider (api.trocador.app) sends no `Access-Control-Allow-Origin`
 * for a `tauri://` origin, so a plain webview fetch from the desktop app is
 * refused and the user sees "Load failed" the moment they ask for a quote. The
 * extension never hit this: it declares `<all_urls>` host permissions, which
 * bypasses CORS, so the same code worked there and only desktop was broken.
 *
 * On desktop we hand the request to Tauri's HTTP plugin, which performs it
 * natively, outside the webview. Everywhere else this returns undefined and
 * callers keep using the global `fetch`, which is correct for the extension.
 *
 * Loaded lazily so the extension bundle never pulls in a Tauri dependency.
 */
export async function nativeFetch(): Promise<typeof fetch | undefined> {
  // `__TAURI_INTERNALS__` is the runtime marker Tauri v2 injects. Probing it
  // avoids importing the plugin in a context where it cannot resolve.
  if (!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return undefined;
  }
  try {
    // Specifier held in a variable on purpose: the plugin is a DESKTOP
    // dependency, and a literal here makes the extension's typecheck fail to
    // resolve a module it will never load. Vite leaves a dynamic specifier
    // alone, so the extension bundle stays free of any Tauri import.
    const spec = '@tauri-apps/plugin-http';
    const mod = (await import(/* @vite-ignore */ spec)) as {
      fetch?: typeof fetch;
    };
    return mod.fetch;
  } catch {
    // Plugin absent or blocked: fall back to the global fetch rather than
    // breaking swap entirely. On desktop that still fails on CORS, but it fails
    // the way it did before rather than throwing somewhere new.
    return undefined;
  }
}
