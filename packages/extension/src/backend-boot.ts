/**
 * Backend selection at context boot — shared by every JS context (background
 * service worker, offscreen runner, popup).
 *
 * The wallet is backend-agnostic: which smirk-backend it talks to is durable
 * user configuration (see `@smirk/core` backend-config store). Each context has
 * its OWN `api` singleton, so each must:
 *   1. apply a sane build-time default synchronously (so an early request has a
 *      base URL), then
 *   2. apply the durable user selection before the first real request, and
 *   3. re-apply whenever ANOTHER context switches the backend.
 *
 * Step 2+3 fix the offscreen/popup auth-desync footgun the e2e suite caught:
 * without it a context registers/authenticates against the build default even
 * when the user picked a self-hosted backend. `applyBackendConfig` also clears
 * the per-backend JWT on a switch, so the context re-bootstraps against the new
 * backend.
 */
import {
  ChromeLocalStorage,
  initSmirkApi,
  loadAndApplyBackend,
  subscribeBackend,
  type WalletApiStyle,
} from '@smirk/core';

/** The build-time default backend. Exported so the Settings -> Backend screen
 *  can display it and offer "reset to default". */
export const DEFAULT_BACKEND: { url: string; apiStyle: WalletApiStyle } = {
  url:
    (import.meta.env.VITE_SMIRK_BACKEND_URL as string | undefined) ||
    'https://api.smirk.cash/api/v1',
  apiStyle:
    ((import.meta.env.VITE_SMIRK_API_STYLE as WalletApiStyle | undefined) ||
      'namespaced') as WalletApiStyle,
};

const FALLBACK = DEFAULT_BACKEND;

/**
 * Point THIS context's api singleton at the configured backend. Call once at
 * context boot. `onChange` fires (after the singleton is re-pointed + the JWT
 * cleared) when another context switches the backend, so the caller can
 * re-bootstrap auth / refresh its UI.
 */
export function bootBackendSelection(onChange?: () => void): void {
  // (1) Immediate default — synchronous, so any request before the async read
  // resolves still has a valid base URL.
  initSmirkApi({ baseUrl: FALLBACK.url, walletApiStyle: FALLBACK.apiStyle });
  const storage = new ChromeLocalStorage();
  // (2) Durable override. Fire-and-forget: the first real request (auth
  // bootstrap, balances) happens well after this resolves.
  void loadAndApplyBackend(storage, FALLBACK);
  // (3) Cross-context re-apply on switch.
  subscribeBackend(storage, () => onChange?.());
}
