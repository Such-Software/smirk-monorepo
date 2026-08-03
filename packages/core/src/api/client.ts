/**
 * Base API client with request handling, retry policy, and bearer-token auth.
 */

// Canonical public v0.3 backend. Real builds pass VITE_SMIRK_BACKEND_URL and a
// stored selection overrides this; it is only the last-resort fallback.
const DEFAULT_API_BASE = 'https://api.smirk.cash/api/v1';

// Use globalThis to store the access token so it's shared across all module
// instances. This is needed because Vite's chunking can create multiple
// copies of this module, each with its own `let accessToken` if we held the
// token in a module-level closure.
const GLOBAL_TOKEN_KEY = '__smirk_api_token__';

function getGlobalToken(): string | null {
  return ((globalThis as Record<string, unknown>)[GLOBAL_TOKEN_KEY] as string | null) ?? null;
}

function setGlobalToken(token: string | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_TOKEN_KEY] = token;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  /** HTTP status code (when available). Useful for detecting 401, 429, etc. */
  status?: number;
  /** Machine-readable error code from backend (e.g. `AUTH_TOKEN_EXPIRED`). */
  code?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// SECURITY: do not reintroduce a body-logging debug switch here. Earlier
// revisions had a `DEBUG_ENDPOINTS` list that `console.log`'d full request
// + response JSON for `/grin/`, `/tips/social`, and `/prices`, including
// `encrypted_key`, slatepacks, and view-key adjacent data. Browser console
// is exposed to crash dumps, screen-share screenshots, and any other
// extension with devtools access. For ad-hoc debugging use Chrome's
// Network panel; never log the body here.

/**
 * Base API client with bearer-token authentication. Subclassed by
 * `SmirkApi` (in `./index.ts`) which mixes in domain-specific methods.
 *
 * Construct directly only if you need to point at a non-default backend
 * (test fixtures, local dev); most callers should use the singleton
 * `api` exported from `./index.ts`.
 */
/** Wallet UTXO route dialect. `flat` (default) targets the legacy backend
 *  (`/wallet/balance`); `namespaced` targets smirk-backend-core
 *  (`/wallet/utxo/balance`). LWS and Grin routes are identical across both. */
export type WalletApiStyle = 'flat' | 'namespaced';

export class ApiClient {
  protected baseUrl: string;
  protected walletApiStyle: WalletApiStyle = 'flat';

  constructor(baseUrl: string = DEFAULT_API_BASE) {
    this.baseUrl = baseUrl;
  }

  /** Point the client at a different backend. Call once at shell startup via
   *  `initSmirkApi` (before the first request) so the wallet is not locked to
   *  the production default and can target staging, local, or a self-hosted
   *  backend. */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /** The configured backend base URL. Callers that must build an absolute URL
   *  (e.g. the NIP-98 `u` tag) read it here. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Select the wallet UTXO route dialect (see {@link WalletApiStyle}). Set
   *  once at startup when targeting a smirk-backend-core instance. */
  setWalletApiStyle(style: WalletApiStyle): void {
    this.walletApiStyle = style;
  }

  getWalletApiStyle(): WalletApiStyle {
    return this.walletApiStyle;
  }

  setAccessToken(token: string | null): void {
    setGlobalToken(token);
  }

  getAccessToken(): string | null {
    return getGlobalToken();
  }

  async request<T>(
    endpoint: string,
    options: RequestInit & { timeoutMs?: number } = {},
  ): Promise<ApiResponse<T>> {
    const accessToken = getGlobalToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    // A caller-supplied Authorization (e.g. the NIP-98 `Nostr <token>` used for
    // sign-in) takes precedence over the session Bearer.
    if (accessToken && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const url = `${this.baseUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      // Per-request timeout override. Most calls use DEFAULT_TIMEOUT_MS; the
      // XMR/WOW decoy fetch (random_outs) can take far longer when the backend's
      // monero-lws is cold (it re-pulls the full RCT output distribution, ~15-42s
      // at idle), so that call passes a larger timeoutMs to avoid aborting a
      // valid-but-slow send. See wallet-lws.ts getRandomOuts.
      const timeoutId = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Try JSON first (our backend's normal { error, code } shape).
        // Many failure paths bypass this: tower-governor 429s return
        // empty bodies, nginx 502/503 returns HTML, and, critically,
        // axum's Json extractor rejection at 422 returns a *plain
        // string* explaining what was wrong with the body shape ("...
        // missing field `signed_timestamp` ..."). Capturing that
        // string is the difference between a useful HTTP 422 error
        // and "HTTP 422" with no context.
        //
        // Read the body as text once and try to JSON.parse it. If
        // that fails, use the text directly as the error message.
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          /* empty body or read failure: leave bodyText '' */
        }
        let bodyJson: { error?: string; code?: string } = {};
        if (bodyText.trim().startsWith('{')) {
          try {
            bodyJson = JSON.parse(bodyText);
          } catch {
            /* not JSON; fall through to text-body fallback */
          }
        }
        const error =
          bodyJson.error ||
          (bodyText && bodyText.trim().length > 0
            ? bodyText.trim().slice(0, 300)
            : `HTTP ${response.status}`);
        return {
          error,
          status: response.status,
          ...(bodyJson.code !== undefined ? { code: bodyJson.code } : {}),
        };
      }

      const data = await response.json();
      return { data, status: response.status };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out'
            : err.message
          : 'Network error';
      return { error: message };
    }
  }

  /**
   * Make a request with automatic retry on 5xx errors and network failures.
   *
   * Does NOT retry on 4xx (client errors); those need caller intervention.
   *
   * Use only for **idempotent** operations (GETs, refresh tokens,
   * check-restore, confirm-sweep). Non-idempotent POSTs (tip creation,
   * claims) MUST use plain `request()` to avoid double-spending side
   * effects on transient network failures.
   */
  async retryableRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this.request<T>(endpoint, options);

      // Success or client error (4xx): don't retry.
      if (result.data || (result.status && result.status < 500)) {
        return result;
      }

      // Last attempt: return whatever we got.
      if (attempt === MAX_RETRIES - 1) {
        return result;
      }

      // Exponential backoff between attempts: 500ms, then 1000ms.
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    return { error: 'Max retries exceeded' };
  }
}
