/**
 * Visibility helpers — single source of truth for "which assets does
 * the user want surfaced right now."
 *
 * Show/Hide is a UI preference layered on top of the asset registry:
 * the wallet still owns keys for every registered asset, but the user
 * can hide assets they don't use so they don't clutter the Home tab,
 * the asset chooser, etc. — and so the backend doesn't burn round-
 * trips fetching balances they'll never see.
 *
 * **Why a dedicated helper instead of inline filters.** Every surface
 * that lists assets needs to honour the user's choice the same way.
 * Inlining `state.ui.hiddenAssets.includes(asset.id)` everywhere
 * makes adding (or changing the semantics of) visibility a search-
 * and-replace job — and inevitably one site forgets, and the wallet
 * shows assets in TipMaker that it doesn't show on Home. This module
 * is the *only* place the visibility decision is computed.
 *
 * Companion to the capability flags on `@smirk/assets` (sendable,
 * receivable, dappBridge, socialTipping): visibility is a *user*
 * preference, capabilities are *asset* facts. A surface filters by
 * BOTH — "the user wants this visible AND the asset supports this
 * feature." See `docs/MULTI_ASSET_ARCHITECTURE.md` for the long-form
 * rationale on capability-driven feature inclusion vs hardcoded
 * inclusion lists.
 *
 * @example
 * ```ts
 * import { visibleAssetIds, isAssetVisible } from '@smirk/core';
 *
 * // Filter a list of asset ids — Home tab, balance poller, ...
 * const visible = visibleAssetIds(sessionState, listAssets());
 *
 * // One-shot check — auto-unhide-on-claim flow
 * if (!isAssetVisible(sessionState, 'wow')) {
 *   await store.update(s => {
 *     s.ui.hiddenAssets = s.ui.hiddenAssets.filter(id => id !== 'wow');
 *   });
 * }
 * ```
 */

import { capAllowsChain, type BackendCapabilities } from '../api/capabilities';

/** Chains the capability contract knows about. */
type ChainId = 'btc' | 'ltc' | 'xmr' | 'wow' | 'grin';
type Caps = BackendCapabilities | null;
import type { AssetDefinition } from '@smirk/assets';
import type { SessionState } from './session-state';

/**
 * Project a list of asset definitions through the user's hidden-set.
 * Returns the visible subset in the same order the input was given —
 * we don't impose our own ordering, that's the caller's UI concern.
 *
 * Assets the registry doesn't know about can't be "hidden" (the
 * stored hide-list is just a string array; we don't validate
 * registration). Stale ids in `hiddenAssets` from a previous build
 * are silently ignored — they'll be cleaned up the next time the
 * user toggles in Settings.
 */
export function visibleAssetIds<T extends Pick<AssetDefinition, 'id'>>(
  state: Pick<SessionState, 'ui'>,
  assets: ReadonlyArray<T>,
  caps?: Caps,
): T[] {
  const hidden = new Set(state.ui.hiddenAssets ?? []);
  // Honour the INSTANCE's advertised chains, not just the user's preferences.
  //
  // `capAllowsChain` existed but had no callers, so `/capabilities` chain
  // downgrades were ignored entirely: an operator who turns off XMR still had it
  // listed, and the user would hit failures deep in a send instead of simply not
  // being offered it. Permissive when caps are unknown, matching capAllowsChain,
  // so a legacy backend keeps serving every chain the wallet knows.
  return assets.filter(
    (a) => !hidden.has(a.id) && capAllowsChain(caps ?? null, a.id as ChainId),
  );
}

/**
 * One-shot "is this asset visible right now?" check. Used by
 * auto-unhide-on-claim and any other site that needs a yes/no
 * rather than a filtered list.
 */
export function isAssetVisible(
  state: Pick<SessionState, 'ui'>,
  assetId: string,
  caps?: Caps,
): boolean {
  return (
    !(state.ui.hiddenAssets ?? []).includes(assetId) &&
    capAllowsChain(caps ?? null, assetId as ChainId)
  );
}

/**
 * Compute the next `hiddenAssets` array after toggling a single
 * asset's visibility. Caller passes the result back into
 * `store.update(s => { s.ui.hiddenAssets = … })`.
 *
 * Idempotent: setting `visible: true` on an already-visible asset
 * is a no-op; same for `visible: false` on an already-hidden one.
 */
export function withAssetVisibility(
  hiddenAssets: ReadonlyArray<string>,
  assetId: string,
  visible: boolean,
): string[] {
  const set = new Set(hiddenAssets);
  if (visible) {
    set.delete(assetId);
  } else {
    set.add(assetId);
  }
  return Array.from(set);
}
