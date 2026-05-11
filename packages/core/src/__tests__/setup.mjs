/**
 * Test setup — polyfill `globalThis.crypto` for Node 18.
 *
 * Node 18 exposes `globalThis.crypto` in the main process but not in
 * the `node --test` subprocess. Production code uses bare `crypto`
 * (Web Crypto, available in browsers, service workers, and Node 19+
 * everywhere); to keep the source clean we patch the global at test
 * boot rather than littering the source with environment guards.
 *
 * Loaded via `node --import` ahead of every test file. No-op when
 * `globalThis.crypto` is already populated.
 */

if (typeof globalThis.crypto === 'undefined') {
  const { webcrypto } = await import('node:crypto');
  // The Node typings for `webcrypto` are stricter than the Web Crypto
  // global type; the runtime shape matches.
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}
