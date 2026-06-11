/**
 * Client-side proof-of-work utility for wallet registration.
 *
 * Pairs with the backend's `/api/v1/auth/pow-challenge` endpoint and the
 * `altcha_solution` field on `/auth/extension`. The wallet calls
 * `solvePowChallenge(api)` once before submitting a registration; the
 * returned payload is the JSON the wallet posts back to the server.
 *
 * Why we always solve, even when the backend's `POW_REQUIRED=false`:
 * the gate ships gracefully (false by default during migration) so
 * v0.2.x clients keep working. v0.3.0 always sends a solution so
 * flipping the env var later is a one-step server change with zero
 * client-redeploy. The ~1-2s cost is invisible behind the existing
 * onboarding animations.
 *
 * Network failure handling: if the challenge fetch fails, the wallet
 * should NOT block onboarding — the backend will accept the
 * registration with no `altcha_solution` field while
 * `POW_REQUIRED=false`. Caller should treat solve failures as a soft
 * warning and continue. Once `POW_REQUIRED=true`, of course, the
 * backend rejects no-solution requests with a clear error message.
 */

import { solveChallenge, type Challenge, type Solution } from 'altcha-lib';

/**
 * Wire shape sent to the backend as `altcha_solution`. Mirrors the
 * Rust `altcha::Payload` struct in `smirk-backend/src/api/auth.rs`
 * (the `ExtensionRegisterRequest.altcha_solution` field). The
 * `challenge` here is the FULL original Challenge the server signed,
 * NOT the Solution's internal `challenge` hash field — that wrapping
 * is the bug we hit in 2026-06 when the SW bootstrap handler shipped
 * a bare Solution. Lock it at the type level so a future regression
 * is a compile error, not a runtime 422.
 */
export interface AltchaPayload {
  challenge: Challenge;
  solution: Solution;
}
// `altcha-lib/algorithms/pbkdf2` pulls `node:crypto` + `node:util` —
// fine under Node.js but breaks Vite's browser bundle. The `web/`
// variant uses `crypto.subtle.deriveKey` directly, which works in
// the extension popup, the desktop Tauri webview, and any modern
// browser context.
import { deriveKey as pbkdf2DeriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import type { AuthMethods } from './api';

/**
 * Maximum time we allow the solver to run. 30s is generous enough for
 * cheap mobile devices to solve ALTCHA_COST=100_000 even with thermal
 * throttling; cutting off prevents an infinite spinner if the user
 * hits a pathological browser environment.
 */
const SOLVE_TIMEOUT_MS = 30_000;

/**
 * Solve the backend's current PoW challenge and return the payload to
 * forward to `extensionRegister({ altchaSolution: ... })`.
 *
 * Returns `null` if the challenge fetch fails or the solver times out
 * — caller should pass through to registration without `altchaSolution`,
 * which the backend accepts in graceful-migration mode.
 *
 * Optional `signal` lets the caller cancel mid-solve (e.g. user
 * closed the wallet). Returns `null` on cancellation.
 */
export async function solvePowChallenge(
  api: Pick<AuthMethods, 'powChallenge'>,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<AltchaPayload | null> {
  let challenge: Challenge;
  try {
    const fetched = await api.powChallenge();
    if (fetched.error || !fetched.data) {
      console.warn('[pow] challenge fetch failed:', fetched.error);
      return null;
    }
    challenge = fetched.data as Challenge;
  } catch (e) {
    console.warn('[pow] challenge fetch threw:', e);
    return null;
  }

  // Watchdog: hard timeout in case the browser environment is broken
  // (e.g. WebKitGTK quirk or worker spawn refused on a hardened
  // platform).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOLVE_TIMEOUT_MS);
  // Caller-supplied signal wins if it fires earlier (e.g. user closed
  // the wallet mid-solve).
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const solution = await solveChallenge({
      challenge,
      controller,
      deriveKey: pbkdf2DeriveKey,
    });
    if (!solution) {
      console.warn('[pow] solver returned null (timeout or aborted)');
      return null;
    }
    return { challenge, solution };
  } catch (e) {
    console.warn('[pow] solver threw:', e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
