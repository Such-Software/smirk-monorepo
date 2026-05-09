/**
 * `@smirk/assets` — registry of every chain Smirk supports.
 *
 * Pure-data definitions: decimals, family classification, capability
 * flags, network params, confirmation requirements. Imports nothing
 * chain-specific — definitions are JSON-serializable and trivially
 * testable.
 *
 * Crypto functions (validate, derive, sign) live in `@smirk/wasm`
 * (Rust → wasm-bindgen) for chain-specific work and `@smirk/core`
 * for pure-JS chains. Consumers compose registry data with adapter
 * code at the call site.
 *
 * Built-ins register at module load. Add a new asset later via
 * `registry.register(myAsset)` — no recompile needed.
 *
 * @example
 * ```ts
 * import { registry, ASSET_IDS } from '@smirk/assets';
 *
 * const btc = registry.mustGet(ASSET_IDS.BTC);
 * console.log(btc.decimals);  // 8
 *
 * for (const asset of registry.list({ swapRoute: 'thorchain' })) {
 *   console.log(asset.ticker);  // BTC, LTC, XMR
 * }
 * ```
 */

import { AssetRegistry } from './registry';
import { btc } from './assets/btc';
import { ltc } from './assets/ltc';
import { xmr } from './assets/xmr';
import { wow } from './assets/wow';
import { grin } from './assets/grin';

// ----- Re-exports -----

export type {
  AssetId,
  AssetDefinition,
  AddressKind,
  ChainFamily,
  FamilyData,
  UtxoFamilyData,
  CryptonoteFamilyData,
  MimblewimbleFamilyData,
  NetworkName,
  NetworkInfo,
  SwapRoute,
} from './types';

export { AssetRegistry, AssetRegistryError, type ListFilter } from './registry';

// ----- Built-in definitions, exported for direct import -----
//
// Most consumers should go through `registry.get(id)`, but having
// these as named constants is useful for tests, type-safe asset
// references, and tree-shaking when only a single asset's data
// is needed.

export { btc, ltc, xmr, wow, grin };

// ----- Stable id constants -----
//
// Avoids magic strings at call sites. Keep this in sync with the
// `id` field of each definition.

export const ASSET_IDS = {
  BTC: 'btc',
  LTC: 'ltc',
  XMR: 'xmr',
  WOW: 'wow',
  GRIN: 'grin',
} as const;

export type BuiltInAssetId = (typeof ASSET_IDS)[keyof typeof ASSET_IDS];

// ----- Singleton registry, with built-ins pre-registered -----

const builtInRegistry = new AssetRegistry();

/**
 * Bootstrap order matters: `list()` returns assets in registration
 * order, and the wallet UI renders the asset list in that order.
 *
 * Current ordering reflects rough "user familiarity" — most-recognized
 * chains first, with the interactive Grin chain last so the UI can
 * visually separate or batch-treat the slatepack-paradigm row.
 */
const BUILT_INS = [btc, ltc, xmr, wow, grin] as const;
for (const def of BUILT_INS) {
  builtInRegistry.register(def);
}

/**
 * The shared singleton registry. The 5 built-in assets register
 * at module-load time; later assets can be added via
 * `registry.register(def)`.
 */
export const registry: AssetRegistry = builtInRegistry;

/** Convenience helpers — most callers should use these. */

export function getAsset(id: string) {
  return registry.get(id);
}

export function mustGetAsset(id: string) {
  return registry.mustGet(id);
}

export function listAssets(filter?: import('./registry').ListFilter) {
  return registry.list(filter);
}
