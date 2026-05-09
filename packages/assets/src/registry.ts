/**
 * In-memory asset registry.
 *
 * Designed to be static-first (the 5 built-in assets register at
 * module load) but dynamic-capable from day 1: a host can call
 * `register(def)` later to add a new asset without recompiling
 * `@smirk/assets`.
 *
 * The registry never validates *cryptographic* claims on
 * registration — it only enforces structural invariants (id is
 * lowercase, no duplicate id, decimals is non-negative, etc.).
 * Capability validation is the consumer's job at the point of use.
 */

import type {
  AssetDefinition,
  AssetId,
  ChainFamily,
  NetworkName,
  SwapRoute,
} from './types';

// ============================================================================
// Errors
// ============================================================================

export class AssetRegistryError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetRegistryError';
  }
}

// ============================================================================
// Filters for `list()`
// ============================================================================

export interface ListFilter {
  family?: ChainFamily;
  network?: NetworkName;
  swapRoute?: SwapRoute;
  socialTippingOnly?: boolean;
  /** Filter to assets that have a specific UTXO feature, e.g. `mweb`. */
  hasUtxoFeature?: 'mweb' | 'taproot' | 'segwit' | 'psbt';
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Asset registry. Singleton in practice (exported as `registry` from
 * `./index`), but the class is constructable so tests can build
 * isolated registries without touching the global state.
 */
export class AssetRegistry {
  private readonly assets = new Map<AssetId, AssetDefinition>();

  /**
   * Register a new asset. Throws `AssetRegistryError` if the id
   * collides with an already-registered asset, or if the definition
   * fails structural validation.
   *
   * Registering the same definition twice is an error, not a no-op
   * — collisions usually indicate two modules trying to claim the
   * same id, which is a bug worth surfacing.
   */
  register(def: AssetDefinition): void {
    validateStructural(def);

    if (this.assets.has(def.id)) {
      throw new AssetRegistryError(
        `Asset id "${def.id}" is already registered (existing: ${
          this.assets.get(def.id)?.displayName
        })`,
      );
    }

    this.assets.set(def.id, def);
  }

  /**
   * Retrieve a definition by id, or `undefined` if unregistered.
   * Use `mustGet` if absence is a bug rather than a normal control flow.
   */
  get(id: AssetId): AssetDefinition | undefined {
    return this.assets.get(id);
  }

  /**
   * Retrieve a definition by id, throwing if missing. Useful in
   * code paths where the id came from a typed source (registry-driven
   * UI, registry-driven test fixtures) so absence is a programming
   * error.
   */
  mustGet(id: AssetId): AssetDefinition {
    const def = this.assets.get(id);
    if (!def) {
      throw new AssetRegistryError(`No asset registered with id "${id}"`);
    }
    return def;
  }

  has(id: AssetId): boolean {
    return this.assets.has(id);
  }

  /**
   * All registered ids, in registration order. Mostly useful for
   * tests and devtools; UI code should usually iterate the rich
   * definitions via `list()`.
   */
  ids(): AssetId[] {
    return Array.from(this.assets.keys());
  }

  /**
   * All registered definitions, optionally filtered. Iteration order
   * is registration order, which the bootstrap deliberately makes
   * meaningful (BTC, LTC, XMR, WOW, Grin reflects a rough "user
   * familiarity" ordering for the asset list).
   */
  list(filter?: ListFilter): AssetDefinition[] {
    let out = Array.from(this.assets.values());

    if (!filter) return out;

    if (filter.family !== undefined) {
      out = out.filter((a) => a.family.family === filter.family);
    }
    if (filter.network !== undefined) {
      out = out.filter((a) => a.networks[filter.network!] !== undefined);
    }
    if (filter.swapRoute !== undefined) {
      out = out.filter((a) => a.swapRoutes.includes(filter.swapRoute!));
    }
    if (filter.socialTippingOnly === true) {
      out = out.filter((a) => a.socialTipping);
    }
    if (filter.hasUtxoFeature !== undefined) {
      const feat = filter.hasUtxoFeature;
      out = out.filter((a) => a.family.family === 'utxo' && a.family.features[feat]);
    }

    return out;
  }

  /**
   * Number of registered assets. Useful for sanity checks
   * ("registry should have at least the 5 built-ins").
   */
  size(): number {
    return this.assets.size;
  }

  /**
   * Remove every registered asset. Test-only — production code
   * should never call this. Re-run the bootstrap after clearing.
   */
  _clearForTests(): void {
    this.assets.clear();
  }
}

// ============================================================================
// Structural validation
// ============================================================================

/**
 * Cheap structural checks run at `register()` time. These catch
 * obvious mistakes (negative decimals, mainnet not in networks,
 * mixed-case id) without trying to validate cryptographic facts —
 * those are the consumer's responsibility at the point of use.
 */
function validateStructural(def: AssetDefinition): void {
  if (!def.id || def.id !== def.id.toLowerCase()) {
    throw new AssetRegistryError(
      `Asset id must be a non-empty lowercase string (got "${def.id}")`,
    );
  }
  if (def.decimals < 0 || !Number.isInteger(def.decimals)) {
    throw new AssetRegistryError(
      `Asset "${def.id}" has invalid decimals: ${def.decimals}`,
    );
  }
  if (def.confirmationsRequired < 0 || !Number.isInteger(def.confirmationsRequired)) {
    throw new AssetRegistryError(
      `Asset "${def.id}" has invalid confirmationsRequired: ${def.confirmationsRequired}`,
    );
  }
  if (Object.keys(def.networks).length === 0) {
    throw new AssetRegistryError(`Asset "${def.id}" has no networks defined`);
  }
  if (def.networks[def.defaultNetwork] === undefined) {
    throw new AssetRegistryError(
      `Asset "${def.id}" defaultNetwork "${def.defaultNetwork}" is not in its networks map`,
    );
  }
  if (def.family.family === 'cryptonote') {
    if (def.family.ringSize < 2) {
      throw new AssetRegistryError(
        `CryptoNote asset "${def.id}" has invalid ringSize: ${def.family.ringSize}`,
      );
    }
  }
}
