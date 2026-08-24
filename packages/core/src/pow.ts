/**
 * Client-side proof-of-work utility for wallet registration.
 *
 * Pairs with the backend's `/api/v1/auth/pow-challenge` endpoint and the
 * `altcha_solution` field on `/auth/extension`. The wallet calls
 * `solvePowChallenge(api)` once before submitting a registration; the
 * returned payload is the JSON the wallet posts back to the server.
 *
 * When we solve. Only genuinely new wallets solve. Every bootstrap
 * path (`bootstrapAuth`, the extension SW handler, the nostr
 * bootstrap) skips the solve when `checkRestore` reports a known
 * fingerprint, mirroring the backend's `is_returning_user` bypass.
 * A new wallet always sends a solution even when the backend's
 * `POW_REQUIRED=false`, so the operator can flip the env var with no
 * client redeploy; the ~1-2s cost hides behind the existing
 * onboarding animations.
 *
 * Network failure handling: if the challenge fetch fails, the wallet
 * should NOT block onboarding: the backend will accept the
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
 * NOT the Solution's internal `challenge` hash field: that wrapping
 * is the bug we hit in 2026-06 when the SW bootstrap handler shipped
 * a bare Solution. Lock it at the type level so a future regression
 * is a compile error, not a runtime 422.
 */
export interface AltchaPayload {
  challenge: Challenge;
  solution: Solution;
}
// `altcha-lib/algorithms/pbkdf2` pulls `node:crypto` + `node:util`:
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
 * Returns `null` if the challenge fetch fails or the solver times out;
 * caller should pass through to registration without `altchaSolution`,
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

// ============================================================================
// Restore proof-of-work
// ============================================================================

/**
 * Solve the RESTORE proof-of-work, which is a different gate from the ALTCHA
 * registration challenge above.
 *
 * An operator prices a chain rescan by depth: scanning a foreign seed back
 * through a year of blocks costs their LWS real work, so beyond
 * `restore.pow_free_days` the backend demands a hashcash nonce whose difficulty
 * grows one bit per `restore.pow_days_per_bit`, capped at `pow_max_bits`
 * (smirk-backend-core `core/restore_pow.rs`, `RestoreConfig`).
 *
 * Why this exists: the wire field (`restore_pow_nonce`) was plumbed end to end
 * while nothing ever produced a value for it, so any priced restore failed with
 * "this restore depth requires an N-bit proof-of-work nonce; upgrade to a newer
 * Smirk client". On a backend with pricing enabled that took out GRIN balances
 * outright, because `fetchGrinBalance` sent no `start_height` and the backend
 * therefore assumed its deepest allowed scan.
 *
 * The work is self-contained: no server challenge, no state. It is bound to
 * `(asset, address, start_height)`, so a solution cannot be precomputed
 * generically, replayed on another account, or reused for a cheaper depth.
 *
 * Costs are small by construction: 9 bits is ~512 hashes, and the usual cap of
 * 24 bits is ~16.7M, seconds of work for a one-time deep restore.
 */

/** Domain tag; must match `restore_pow::DOMAIN` byte for byte. */
const RESTORE_POW_DOMAIN = 'smirk-restore-pow-v1';
/** Field separator between preimage segments (`0x1f`, ASCII unit separator). */
const RESTORE_POW_SEP = 0x1f;

/** Target block rates, mirroring the backend's `blocks_per_day`. */
const BLOCKS_PER_DAY: Record<string, number> = {
  xmr: 720, // ~120s
  wow: 720, // ~120s
  grin: 1440, // ~60s
  btc: 144, // ~600s
  ltc: 576, // ~150s
};

/** Pricing knobs from `GET /capabilities` → `restore`. */
export interface RestorePowPolicy {
  pow_free_days?: number | undefined;
  pow_days_per_bit?: number | undefined;
  pow_max_bits?: number | undefined;
  /**
   * Deepest scan the operator serves at all, in days. `null` on an unbounded
   * policy, which is why this is not merely optional: it mirrors
   * `RestoreCapability` from `api/capabilities` so the capability object can be
   * handed over as-is, with no lossy remapping at the call site.
   */
  max_depth_days?: number | null | undefined;
}

/**
 * Difficulty the backend will demand for this scan, mirroring
 * `RestoreConfig::required_restore_pow_bits`. Returns 0 when the operator
 * prices nothing or the depth sits inside the free window.
 *
 * Kept as an exact mirror rather than "solve whatever the error asked for":
 * knowing the cost up front means we can solve before the round trip instead of
 * failing once and retrying.
 */
export function requiredRestorePowBits(
  asset: string,
  startHeight: number,
  tip: number,
  policy: RestorePowPolicy,
): number {
  const perBit = policy.pow_days_per_bit ?? 0;
  if (perBit <= 0) return 0;
  const perDay = BLOCKS_PER_DAY[asset] ?? 720;
  const depthDays = Math.floor(Math.max(0, tip - startHeight) / Math.max(1, perDay));
  const over = Math.max(0, depthDays - (policy.pow_free_days ?? 0));
  const bits = Math.floor(over / perBit);
  return Math.min(policy.pow_max_bits ?? bits, bits);
}

/** Leading zero BITS of a digest; the hashcash difficulty metric. */
function leadingZeroBits(digest: Uint8Array): number {
  let n = 0;
  for (const b of digest) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

/**
 * Find a nonce satisfying `bits` for this exact restore.
 *
 * `address` is whatever the backend binds the work to for that asset: the
 * receive address for xmr/wow, and for grin the `rewind_hash`, since that is
 * what identifies the scan (see the `restore_pow_nonce` note in the OpenAPI
 * schema).
 *
 * Returns `undefined` when nothing is owed, so callers can spread the result
 * straight into request params without branching.
 */
export async function solveRestorePow(
  asset: string,
  address: string,
  startHeight: number,
  bits: number,
): Promise<number | undefined> {
  if (bits <= 0) return undefined;

  const enc = new TextEncoder();
  const head = enc.encode(RESTORE_POW_DOMAIN);
  const assetBytes = enc.encode(asset);
  const addrBytes = enc.encode(address);

  // domain ‖ 0x1f ‖ asset ‖ 0x1f ‖ address ‖ 0x1f ‖ start_height(le u64) ‖ nonce(le u64)
  const prefixLen = head.length + 1 + assetBytes.length + 1 + addrBytes.length + 1 + 8;
  const buf = new Uint8Array(prefixLen + 8);
  let o = 0;
  buf.set(head, o); o += head.length;
  buf[o++] = RESTORE_POW_SEP;
  buf.set(assetBytes, o); o += assetBytes.length;
  buf[o++] = RESTORE_POW_SEP;
  buf.set(addrBytes, o); o += addrBytes.length;
  buf[o++] = RESTORE_POW_SEP;
  const view = new DataView(buf.buffer);
  view.setBigUint64(o, BigInt(startHeight), true); o += 8;
  const nonceOffset = o;

  for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce++) {
    view.setBigUint64(nonceOffset, BigInt(nonce), true);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (leadingZeroBits(digest) >= bits) return nonce;
  }
  throw new Error(`restore proof-of-work: no nonce found for ${bits} bits`);
}
