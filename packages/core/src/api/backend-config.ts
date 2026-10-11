/**
 * Durable backend selection: which smirk-backend the wallet talks to.
 *
 * The wallet is backend-agnostic: the default public instance (api.smirk.cash),
 * a self-hosted smirk-backend-core, or another operator's. The chosen backend is
 * stored durably (e.g. chrome.storage.local) so EVERY JS context (background
 * service worker, offscreen runner, popup) reads the same value at boot and
 * re-applies it on change. Auth (JWT) is per-backend, so switching clears the
 * token and the shell re-bootstraps against the new backend.
 */
import type { PlatformStorage } from '../state/platform';
import type { WalletApiStyle } from './client';
import type { BackendCapabilities } from './capabilities';
import { api } from './index';

/** Durable storage key for the selected backend. */
export const BACKEND_CONFIG_KEY = 'smirk_backend_v1';

export interface BackendConfig {
  /** Absolute API base URL, e.g. `https://api.smirk.cash/api/v1`. */
  url: string;
  /** UTXO route dialect; auto-detected from the backend's capabilities. */
  apiStyle: WalletApiStyle;
  /** Operator-advertised instance name (display only). */
  instanceName?: string;
  /** When the user selected this backend (epoch ms). */
  chosenAt: number;
}

export async function readBackendConfig(
  storage: PlatformStorage,
): Promise<BackendConfig | null> {
  return storage.get<BackendConfig>(BACKEND_CONFIG_KEY);
}

export async function writeBackendConfig(
  storage: PlatformStorage,
  cfg: BackendConfig,
): Promise<void> {
  await storage.set(BACKEND_CONFIG_KEY, cfg);
}

export async function clearBackendConfig(storage: PlatformStorage): Promise<void> {
  await storage.remove(BACKEND_CONFIG_KEY);
}

/**
 * Point the shared `api` singleton at `cfg`. Clears the access token because a
 * JWT minted by one backend is meaningless to another; the shell re-bootstraps
 * auth against the new backend after this.
 */
export function applyBackendConfig(cfg: {
  url: string;
  apiStyle: WalletApiStyle;
}): void {
  api.setBaseUrl(cfg.url);
  api.setWalletApiStyle(cfg.apiStyle);
  api.setAccessToken(null);
}

/** The backend a context should be talking to, and whether the user chose it. */
export interface BackendSelection {
  url: string;
  apiStyle: WalletApiStyle;
  /** False when nothing is stored and the build-time default applies. */
  stored: boolean;
}

/**
 * The effective selection without applying it: the stored choice, or
 * `fallback` (the build-time default from `VITE_SMIRK_BACKEND_URL` /
 * `VITE_SMIRK_API_STYLE`) when the user never chose one or reset to it.
 */
export async function resolveBackend(
  storage: PlatformStorage,
  fallback: { url: string; apiStyle: WalletApiStyle },
): Promise<BackendSelection> {
  const cfg = await readBackendConfig(storage);
  if (cfg && cfg.url) return { url: cfg.url, apiStyle: cfg.apiStyle, stored: true };
  return { url: fallback.url, apiStyle: fallback.apiStyle, stored: false };
}

/**
 * Boot-time backend resolution for every JS context. Reads the durable config
 * and applies it; when absent, applies `fallback`. Returns the effective
 * selection so the caller can display it / decide whether onboarding runs.
 */
export async function loadAndApplyBackend(
  storage: PlatformStorage,
  fallback: { url: string; apiStyle: WalletApiStyle },
): Promise<BackendSelection> {
  const selection = await resolveBackend(storage, fallback);
  applyBackendConfig(selection);
  return selection;
}

/**
 * Follow the selection whenever ANOTHER context changes it (the
 * offscreen-desync footgun otherwise). Returns an unsubscribe fn.
 *
 * Clearing the selection is a change too: "reset to the default backend"
 * removes the stored config, and every other context must then move to
 * `fallback`. This used to apply only a non-empty config, so after a reset the
 * background worker and any second wallet window stayed on the operator the
 * user had just left, and the next background sign-in registered there.
 *
 * A context already pointed at the selection (normally the one that made the
 * change) is left alone, so a session token it has just minted survives.
 * `onChange` fires only when this context was actually re-pointed. When the
 * selection cannot be read, the session token is dropped: a context that
 * cannot confirm its backend must not keep authenticating to one.
 */
export function subscribeBackend(
  storage: PlatformStorage,
  fallback: { url: string; apiStyle: WalletApiStyle },
  onChange?: (selection: BackendSelection) => void,
): () => void {
  return storage.subscribe((key) => {
    if (key !== BACKEND_CONFIG_KEY) return;
    void resolveBackend(storage, fallback).then(
      (selection) => {
        if (
          api.getBaseUrl() === selection.url &&
          api.getWalletApiStyle() === selection.apiStyle
        ) {
          return;
        }
        applyBackendConfig(selection);
        onChange?.(selection);
      },
      (e: unknown) => {
        api.setAccessToken(null);
        console.warn(
          '[backend-config] could not read the backend selection after it changed; signed out of',
          api.getBaseUrl(),
          e,
        );
      },
    );
  });
}

export interface ConnectResult {
  ok: boolean;
  /** The normalized URL that was probed (https-forced, `/api/v1` appended). */
  url: string;
  apiStyle?: WalletApiStyle;
  capabilities?: BackendCapabilities;
  error?: string;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Origins where plain http is legitimate, so requiring https would make the
 * instance unreachable rather than more secure.
 *
 * `.onion` carries its own transport authentication and encryption, and Tor
 * Browser and arti both treat http onions as secure origins; there is no CA that
 * will issue for one. Private-range and `.local` addresses are how a self-hoster
 * actually runs a box on their own LAN. Rejecting both meant the "run your own
 * backend" promise only held for someone with a public domain and a certificate,
 * which is the opposite of the intent.
 */
const HTTP_OK_ORIGIN =
  /^https?:\/\/(?:[a-z2-7]{16}|[a-z2-7]{56})\.onion(?::\d+)?(?:\/|$)|^https?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local)(?::\d+)?(?:\/|$)/i;

/**
 * Validate + probe a candidate backend BEFORE committing to it (never mutates
 * the singleton). Enforces https (loopback exempt for local dev), fetches
 * `GET {url}/capabilities`, and derives the UTXO route dialect: a numeric
 * `contract_version` ⇒ smirk-backend-core ⇒ `namespaced`; otherwise legacy
 * `flat`. The onboarding "choose backend" step and the Settings screen call
 * this and show the returned instance name / chains / restore policy.
 */
export async function connectBackend(rawUrl: string): Promise<ConnectResult> {
  let url = rawUrl.trim().replace(/\/+$/, '');
  if (!url) return { ok: false, url, error: 'Enter a backend URL.' };
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url.startsWith('https://') && !LOOPBACK.test(url) && !HTTP_OK_ORIGIN.test(url)) {
    return {
      ok: false,
      url,
      error: 'Backend URL must use https:// (or be a .onion, LAN, or localhost address).',
    };
  }
  // Accept a bare origin (append the versioned API base the wallet speaks).
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  try {
    const res = await fetch(`${url}/capabilities`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, url, error: `Backend returned HTTP ${res.status}.` };
    }
    const caps = (await res.json()) as BackendCapabilities;
    const apiStyle: WalletApiStyle =
      typeof caps?.contract_version === 'number' ? 'namespaced' : 'flat';
    return { ok: true, url, apiStyle, capabilities: caps };
  } catch {
    return { ok: false, url, error: 'Could not reach that backend. Check the URL.' };
  }
}
