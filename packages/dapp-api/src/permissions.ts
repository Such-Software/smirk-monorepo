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
