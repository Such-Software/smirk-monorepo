/**
 * `installSmirkPageApi`: runtime installer for `window.smirk`,
 * intended to be called by dapp pages that want to support Smirk
 * across every shipping environment without writing per-environment
 * detection code themselves.
 *
 * Three deployment shapes for the same dapp page:
 *
 *  1. **Browser extension (Smirk v0.2.x)**: the extension's content
 *     script has already installed `window.smirk` before the page's
 *     own scripts run. `installSmirkPageApi()` sees the existing
 *     surface and is a no-op. Existing dapps that target only the
 *     extension keep working with zero changes.
 *
 *  2. **Smirk desktop (v0.3.0+) embedded browser**: the dapp page
 *     loads in an iframe inside the wallet. There is no extension,
 *     no `window.smirk`. `installSmirkPageApi()` detects the parent-
 *     frame context and installs a `window.smirk` whose every
 *     method is a `window.parent.postMessage` round-trip against
 *     the wallet's RPC handler. The wallet's UI surfaces a normal
 *     approval modal; the page sees the same Promise-returning API
 *     as the extension surface.
 *
 *  3. **Standalone page (no Smirk)**: neither the extension nor a
 *     Smirk iframe parent is present. `installSmirkPageApi()` does
 *     nothing; `window.smirk` stays undefined and the page's normal
 *     "install Smirk" prompt covers the gap.
 *
 * The contract is intentionally narrow: detect → install once →
 * return. The page calls this exactly once near document-start.
 * Subsequent calls are no-ops.
 *
 * Why a runtime helper rather than another build-time script string:
 * the dapp page already has a build pipeline (Next.js, Vite, etc.).
 * Asking it to splice in an opaque IIFE is awkward; offering an ESM
 * function it can `import` and call is the same idiom as
 * `@walletconnect`, `@solana/wallet-adapter`, `viem`, etc.
 */

import { PROTOCOL_VERSION } from './protocol';

/**
 * Default postMessage channel discriminator. Must match the value
 * the wallet's `IframeBrowserContent` checks for. Exposed as a
 * constant because dapps that want a non-default channel (e.g.
 * staging vs production) can pass an override.
 */
export const DEFAULT_POSTMESSAGE_CHANNEL = 'smirk:dapp';

/** Options accepted by `installSmirkPageApi`. */
export interface InstallSmirkPageApiOptions {
  /**
   * Override the postMessage channel. Defaults to
   * {@link DEFAULT_POSTMESSAGE_CHANNEL}. Useful in tests where the
   * page and wallet are talking on a non-default channel.
   */
  readonly channel?: string;

  /**
   * Per-request timeout in milliseconds. If a postMessage round-
   * trip exceeds this, the page-side Promise rejects with a
   * `TIMEOUT` error. Default 30s, generous because the user may
   * be reading an approval prompt. Set lower in tests.
   */
  readonly timeoutMs?: number;

  /**
   * Override the parent-frame detection. By default we install the
   * postMessage transport when `window.parent !== window` (i.e. the
   * page is iframed). Set to `'force'` to always install (useful in
   * tests that run inside an iframe but want the page-side runtime
   * even when the wallet isn't listening yet) or `'never'` to skip
   * the install entirely.
   */
  readonly mode?: 'auto' | 'force' | 'never';

  /**
   * Called once when the page-side runtime is wired. Use this to
   * dispatch your own `smirk-ready` event or update UI state. Not
   * called when the install is a no-op (extension already present,
   * or no parent frame in `'auto'` mode).
   */
  readonly onReady?: () => void;
}

/**
 * Install `window.smirk` on the current page if a Smirk wallet
 * context is detected and no `window.smirk` already exists.
 *
 * Returns `'extension-present'` if `window.smirk` was already
 * installed (extension content script ran first), `'iframe-mode'`
 * if we installed the postMessage runtime, or `'none'` if we did
 * nothing (no parent frame in auto mode, or `mode: 'never'`).
 *
 * Safe to call multiple times. Idempotent.
 */
export function installSmirkPageApi(
  options: InstallSmirkPageApiOptions = {},
): 'extension-present' | 'iframe-mode' | 'none' {
  if (typeof window === 'undefined') return 'none';

  // Extension content script already installed window.smirk;
  // never overwrite. The page's existing v0.2.x integration code
  // keeps working untouched.
  if (typeof window.smirk !== 'undefined') {
    return 'extension-present';
  }

  const mode = options.mode ?? 'auto';
  if (mode === 'never') return 'none';
  // 'auto' requires a parent frame distinct from self; that is
  // our signal that we're embedded inside the wallet's iframe.
  if (mode === 'auto' && window.parent === window) return 'none';

  const channel = options.channel ?? DEFAULT_POSTMESSAGE_CHANNEL;
  const timeoutMs = options.timeoutMs ?? 30_000;

  installPostMessageRuntime(channel, timeoutMs);
  options.onReady?.();
  return 'iframe-mode';
}

// Internals: keep below the public surface so a reader sees the
// docstring + signature without scrolling.

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireResponse {
  type: 'SMIRK_RESPONSE';
  v: number;
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

function installPostMessageRuntime(channel: string, timeoutMs: number): void {
  const pending = new Map<number, PendingEntry>();
  let nextId = 1;

  function request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Object.assign(new Error(`Smirk wallet timed out responding to ${method}`), {
            code: 'TIMEOUT',
          }),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        {
          channel,
          payload: {
            type: 'SMIRK_REQUEST',
            v: PROTOCOL_VERSION,
            id,
            method,
            params: params ?? {},
          },
        },
        '*',
      );
    });
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as
      | { channel?: unknown; payload?: WireResponse }
      | null
      | undefined;
    if (!data || data.channel !== channel) return;
    const resp = data.payload;
    if (!resp || resp.type !== 'SMIRK_RESPONSE') return;
    const entry = pending.get(resp.id);
    if (!entry) return;
    pending.delete(resp.id);
    clearTimeout(entry.timer);
    if (resp.error) {
      entry.reject(
        Object.assign(new Error(resp.error.message), { code: resp.error.code }),
      );
    } else {
      entry.resolve(resp.result);
    }
  });

  const api = {
    isInstalled: (): boolean => true,
    protocolVersion: (): number => PROTOCOL_VERSION,
    isUnlocked: (): Promise<boolean> =>
      request('isUnlocked', {}) as Promise<boolean>,
    isConnected: (): Promise<boolean> =>
      request('isConnected', {}) as Promise<boolean>,
    connect: (assets?: string[]): Promise<unknown> =>
      request('connect', { assets }),
    disconnect: (): Promise<void> =>
      request('disconnect', {}) as Promise<void>,
    getAddresses: (assets?: string[]): Promise<unknown> =>
      request('getAddresses', { assets }),
    getPublicKeys: (assets?: string[]): Promise<unknown> =>
      request('getPublicKeys', { assets }),
    signMessage: (message: string, assets?: string[]): Promise<unknown> =>
      request('signMessage', { message, assets }),
    requestPayment: (req: unknown): Promise<unknown> =>
      request('requestPayment', req),
    claimPublicTip: (tipId: string, fragmentKey: string): Promise<unknown> =>
      request('claimPublicTip', { tipId, fragmentKey }),
  };

  // `writable: false` + `configurable: false` matches the
  // extension's installation contract so dapps can rely on the
  // surface not being swapped out mid-session.
  Object.defineProperty(window, 'smirk', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  window.dispatchEvent(new CustomEvent('smirk-ready'));
}

declare global {
  interface Window {
    smirk?: unknown;
  }
}
