/**
 * Per-origin permission model. A user grants an origin a set of
 * assets (e.g., smirk.cash → [btc] for username registration);
 * subsequent reads for those assets skip the approval prompt while
 * unauthorized reads either prompt fresh or fail closed depending on
 * the method (see WalletHandler).
 *
 * Storage is pluggable per platform. The same shape (`OriginPermission`)
 * is written by every adapter so a future cross-device sync — or just
 * a Settings → Connected Sites UI shared across platforms — can
 * consume one schema.
 */

import { SmirkAsset } from './protocol';

export interface OriginPermission {
  /** Canonical origin: `https://smirk.cash`, `chrome-extension://...`,
   *  or `capacitor://localhost`. Same string the dapp's `window.location.origin`
   *  returns. */
  origin: string;
  /** Assets the user authorized the origin to read. Order is not
   *  significant; consumers should treat it as a set. */
  assets: SmirkAsset[];
  /** Whether the origin may read the user's Nostr identity (npub) and request
   *  Nostr-event signatures. Separate from chain `assets` because exposing the
   *  npub is a distinct, cross-site-correlatable grant. */
  nostr?: boolean;
  /** The x-only pubkey (hex) of the Nostr identity this origin SEES, chosen by the
   *  user at grant time: the wallet's active/main identity, or a per-origin
   *  compartmentalized identity (`deriveNostrIdentityForOrigin`). Persisted so
   *  `getNostrPublicKey` answers from the stored grant instead of the single-value
   *  cache, and the signer resolves the right key. Absent = legacy grant → account-0. */
  nostrPubkey?: string;
  /** Set once the user has been shown that the nostr scope also covers
   *  encrypt/decrypt. Until then the first crypto call prompts, so the scope is
   *  not silently broader than the consent copy described. */
  nostrCryptSeen?: boolean;
  /** Whether the origin may derive its app-scoped e2ee key(s) and ask the wallet
   *  to open boxes sealed to them. A one-time disclosure grant: the key is
   *  origin-bound and unlinkable to identity, so once granted, derive/open need
   *  no per-call prompt (the site is only ever reading its OWN sealed data). */
  e2ee?: boolean;
  /** Time-boxed grant to sign session-grantable Nostr kinds (notes/reactions/
   *  gift-wraps) without re-prompting. NEVER covers money-tier kinds
   *  (17/27235/30402/22242) — see nostr-tiers.ts. Absent = every signature prompts. */
  nostrSession?: { kinds: number[]; expiresAt: number };
  /** Display name from the dapp's `<title>` at approval time. Stored
   *  so Settings → Connected Sites can show something friendlier than
   *  the bare origin. */
  siteName?: string;
  /** Favicon URL captured at approval time. Cached for the same
   *  reason. */
  favicon?: string;
  /** Unix ms. Used by Settings to show "Connected 3 days ago". */
  grantedAt: number;
  /** Unix ms. Bumped on every approved request so Settings can sort
   *  by activity and a future auto-expire policy can revoke idle
   *  origins. */
  lastUsedAt: number;
}

/** Persistence interface. Implementations:
 *  - Extension MV3: chrome.storage.local under `smirk:dapp:origin:<o>`
 *  - Capacitor: IndexedDB (or `@capacitor/preferences` for small sets)
 *  - Tauri: `@tauri-apps/api` store plugin
 *  - Tests: in-memory map */
export interface OriginPermissionStore {
  get(origin: string): Promise<OriginPermission | null>;
  /** Upsert. Implementations should preserve `grantedAt` when
   *  the origin already exists (only first-grant bumps it). */
  set(perm: OriginPermission): Promise<void>;
  remove(origin: string): Promise<void>;
  list(): Promise<OriginPermission[]>;
}

/** Sentinel returned when an origin has no record. Cleaner than
 *  `null` in switch-style checks. */
export const NO_PERMISSION: null = null;

/** True iff the origin has a granted permission that covers EVERY
 *  asset in `wanted`. Empty `wanted` means "any access at all". */
export function hasAssetsAuthorized(
  perm: OriginPermission | null,
  wanted: SmirkAsset[],
): boolean {
  if (!perm) return false;
  if (wanted.length === 0) return perm.assets.length > 0;
  const authorized = new Set(perm.assets);
  return wanted.every((a) => authorized.has(a));
}

/** True iff the origin has been granted the Nostr scope (npub + signing). */
export function hasNostrAuthorized(perm: OriginPermission | null): boolean {
  return !!perm?.nostr;
}

/** True iff the origin has been granted the app-scoped e2ee scope. */
export function hasE2eeAuthorized(perm: OriginPermission | null): boolean {
  return !!perm?.e2ee;
}
