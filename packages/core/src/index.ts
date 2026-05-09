/**
 * @smirk/core — wallet core library.
 *
 * Shared TypeScript code consumed by the browser extension, mobile app,
 * and desktop app. Houses:
 *
 * - **API client** — full-fat client for the Smirk backend
 *   (`auth`, `keys`, `tips`, `social`, `wallet/utxo`, `wallet/lws`,
 *   `grin/relay`, `prices`).
 * - **Crypto** — local seed encryption (PBKDF2 + XChaCha20-Poly1305),
 *   tip envelope encryption (secp256k1 ECDH), Bitcoin message signing
 *   (BIP-137).
 * - **Shared types** — asset enums, tip and key shapes used at the API
 *   surface.
 *
 * Chain-specific transaction crypto lives in `@smirk/wasm` (Rust).
 * `@smirk/core` deliberately doesn't import any wasm module — it stays
 * importable from any context (browser, service worker, Node, Deno).
 *
 * The wallet shells (`@smirk/extension`, `@smirk/mobile`, etc.)
 * compose `@smirk/core` + `@smirk/wasm` + their own UI layer.
 */

export const CORE_PACKAGE_VERSION = '0.0.1';

// API client
export * from './api';

// Crypto
export * from './crypto';

// Shared types
export * from './types';
