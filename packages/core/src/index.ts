/**
 * @smirk/core — wallet core library.
 *
 * Shared TypeScript code consumed by the browser extension, mobile app,
 * and desktop app. Houses:
 * - HD key derivation (BIP-39 + per-asset derivation paths)
 * - API client for the Smirk backend (auth, social tipping, LWS, etc.)
 * - Address codecs (BTC, LTC, XMR/WOW, Grin)
 * - Shared types (wallet state, slate v4 helpers, asset metadata)
 *
 * The current state of this package is **scaffolding**. The substantive
 * code is being migrated in over multiple commits from the legacy
 * `Such-Software/smirk-extension` repo (`src/lib/`).
 *
 * Once migration is complete, the legacy extension will become a thin
 * shell of `packages/extension/` that depends on `@smirk/core` and
 * `@smirk/wasm` instead of carrying its own copy of these modules.
 */

export const CORE_PACKAGE_VERSION = '0.0.1';
