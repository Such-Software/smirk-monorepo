/**
 * Base API client with request handling, retry policy, and bearer-token auth.
 */

const DEFAULT_API_BASE = 'https://backend.smirk.cash/api/v1';

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

/**
 * Endpoints whose request/response details are logged via `console.log`
 * when the request is in flight. Useful for debugging chain-specific flows
 * during development. Match is by substring.
 */
const DEBUG_ENDPOINTS = ['/grin/', '/tips/social', '/prices'];

/**
 * Base API client with bearer-token authentication. Subclassed by
 * `SmirkApi` (in `./index.ts`) which mixes in domain-specific methods.
 *
 * Construct directly only if you need to point at a non-default backend
 * (test fixtures, local dev) — most callers should use the singleton
 * `api` exported from `./index.ts`.
 */
export class ApiClient {
  protected baseUrl: string;

  constructor(baseUrl: string = DEFAULT_API_BASE) {
    this.baseUrl = baseUrl;
  }

  setAccessToken(token: string | null): void {
    setGlobalToken(token);
    console.log('[API] Token set:', token ? 'yes' : 'no');
  }

  getAccessToken(): string | null {
    return getGlobalToken();
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const accessToken = getGlobalToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || 'GET';

    const shouldLog = DEBUG_ENDPOINTS.some((e) => endpoint.includes(e));
    if (shouldLog) {
      console.log(`[API] ${method} ${url}`, {
        hasAuth: !!accessToken,
        body: options.body ? JSON.parse(options.body as string) : undefined,
      });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Unknown error' }));
        if (shouldLog) {
          console.error(`[API] ${method} ${url} FAILED:`, response.status, body);
        }
        return {
          error: body.error || `HTTP ${response.status}`,
          status: response.status,
          code: body.code,
        };
      }

      const data = await response.json();
      if (shouldLog) {
        console.log(`[API] ${method} ${url} OK:`, data);
      }
      return { data, status: response.status };
    } catch (err) {
      if (shouldLog) {
        console.error(`[API] ${method} ${url} EXCEPTION:`, err);
      }
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
   * Does NOT retry on 4xx (client errors) — those need caller intervention.
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

      // Success or client error (4xx) — don't retry.
      if (result.data || (result.status && result.status < 500)) {
        return result;
      }

      // Last attempt — return whatever we got.
      if (attempt === MAX_RETRIES - 1) {
        return result;
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms.
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    return { error: 'Max retries exceeded' };
  }
}
