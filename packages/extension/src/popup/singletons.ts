/**
 * Popup-wide singletons — the persistent stores + router the whole popup shares.
 * Extracted from index.tsx so route components can import them directly instead of
 * reaching back into the entry point (which would be a circular import). One
 * instance each, created at module load.
 */

import {
  ChromeLocalStorage,
  ChromeSessionStorage,
  SessionStateStore,
  RouteController,
  WalletKeystore,
} from '@smirk/core';

/** Durable UI/session state in `chrome.storage.local`. Holds no secrets — only
 *  view state + wizard form fields (recipient/amount), which aren't
 *  privacy-regressing if persisted. */
export const storage = new ChromeLocalStorage();
export const store = new SessionStateStore(storage);
export const router = new RouteController(store);

/**
 * Persistent encrypted-keystore storage in `chrome.storage.local` — survives
 * browser restart, NEVER holds plaintext seed material (the seed is
 * XChaCha20-Poly1305 encrypted under a PBKDF2-stretched password before write).
 * On MV3 service-worker restart the in-memory unlocked state is lost and the user
 * re-enters their password. See docs/SECURITY_AUDIT.md for the rationale.
 */
export const walletKeystore = new WalletKeystore(new ChromeLocalStorage());

/** Ephemeral `chrome.storage.session` cache (cleared on browser close) — the
 *  balance snapshot + unlocked-mnemonic opt-in cache live here. */
export const sessionStorage = new ChromeSessionStorage();
