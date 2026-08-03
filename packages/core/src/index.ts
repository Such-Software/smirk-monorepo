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

/**
 * Reported by the extension background worker in its version response. Kept in
 * step with this package's `package.json` version by hand: `scripts/bump-version.mjs`
 * does not rewrite it.
 */
export const CORE_PACKAGE_VERSION = '0.3.0';

// API client
export * from './api';

// Chain-data plane (provider seam over the API; default = the backend)
export * from './chain';

// Nostr identity (seed-derived npub, NIP-06; the identity-plane foundation)
export * from './nostr';

// Payment transport seam (interactive Grin over backend relay OR Nostr gift-wrap)
export * from './payments/slatepack-channel';
export * from './payments/nostr-channel-io';
export * from './payments/paylink';
export * from './payments/channels';
export * from './payments/grin-pending-overlay';

// v0.2 -> v0.3 migration (detect / decrypt legacy seed / legacy BTC-LTC keys)
export * from './migration';

// Legacy cleanup fund-safety warn-block (gate before deleting the walletState beacon)
export * from './legacy-cleanup';

// Messaging plane (NIP-17 encrypted DMs over the relay, via a swappable seam)
export * from './messaging';

// Crypto
export * from './crypto';

// Address derivation + validation
export * from './address';

// BTC/LTC relay-fee floor (shared by every broadcast path)
export * from './fees';

// HD wallet derivation
export * from './hd';

// BTC/LTC HD gap-limit address book (Lane 5, gated behind ENABLE_BTCLTC_FRESH_ADDRS)
export * from './utxo-addressbook';

// Wallet keystore — encrypted-at-rest seed + unlock state machine
export * from './keystore';

// Bootstrap flows: auth + balances (combines keystore with the API client)
export * from './wallet-flow';

// Anti-abuse client-side helpers (ALTCHA proof-of-work for wallet creation)
export * from './pow';

// Popup state, route persistence, wizard scaffold
export * from './state';

// Shared types
export * from './types';
