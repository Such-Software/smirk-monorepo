/**
 * Asset definition types — the data shape every chain in the Smirk
 * wallet conforms to.
 *
 * Three layers:
 *
 * 1. **Identity** — id, ticker, displayName, decimals. The metadata
 *    every UI surface needs to render an asset.
 *
 * 2. **Behavioral classification** — `addressKind` (does the chain
 *    use addresses or interactive slatepacks?) and `family` (UTXO,
 *    CryptoNote, Mimblewimble) with per-family capability data.
 *
 * 3. **Network parameters** — per-network identifiers and
 *    derivation-path hints. Encoding details (HRP, version bytes)
 *    live in the Rust crypto crates; this layer only carries the
 *    information the UI / orchestration code needs.
 *
 * **Crypto functions are not stored on definitions.** Validate /
 * derive / sign live in `@smirk/wasm` (Rust → wasm-bindgen) or in
 * `@smirk/core` for pure-JS chains. Definitions stay pure-data so
 * they're JSON-serializable, side-effect-free, and trivially
 * testable.
 */

// ============================================================================
// Identity
// ============================================================================

/**
 * Stable asset identifier. Always lowercase. Used as a map key in the
 * registry and (frequently) as the leaf of API request/response
 * fields (e.g. `asset: "btc"`).
 */
export type AssetId = string;

// ============================================================================
// Send paradigm
// ============================================================================

/**
 * How does the user actually send funds with this asset?
 *
 * - `address`     — Classic flow: enter recipient address, amount,
 *                   click send. BTC/LTC/XMR/WOW.
 * - `interactive` — Slatepack-style: build a slate, exchange with
 *                   counterparty, finalize. Grin (and future MW
 *                   chains, Beam, MWC).
 *
 * The wallet UI dispatches on this at the Send-flow entry point.
 */
export type AddressKind = 'address' | 'interactive';

// ============================================================================
// Chain family — discriminated by behavioral / cryptographic shape
// ============================================================================

/**
 * Chain family. Most send/receive logic lives in family-shaped
 * branches; per-asset feature flags (e.g. MWEB on LTC, payment
 * proofs on Grin) live in the family-specific data block.
 */
export type ChainFamily = 'utxo' | 'cryptonote' | 'mimblewimble';

// ----- UTXO (Bitcoin-style) -----

export interface UtxoFamilyData {
  family: 'utxo';
  /**
   * Default address kind generated for new wallets. P2WPKH (BIP84)
   * is current default; we eventually offer P2TR (BIP86) for BTC,
   * MWEB for LTC.
   */
  defaultAddressType: 'p2wpkh' | 'p2tr' | 'p2pkh' | 'p2sh-p2wpkh';
  /**
   * Address types this chain *can* generate from a given xprv. UI
   * uses this to populate the "advanced" address-type picker.
   */
  supportedAddressTypes: ReadonlyArray<UtxoFamilyData['defaultAddressType']>;
  features: {
    /** Native segwit (BIP141 / BIP173). All UTXO chains we support. */
    segwit: boolean;
    /** Taproot (BIP340/341/342). BTC yes; LTC depends on activation. */
    taproot: boolean;
    /** Litecoin MWEB (extension blocks). LTC-specific. */
    mweb: boolean;
    /** PSBT signing (BIP174). Required for hardware-wallet flows. */
    psbt: boolean;
  };
}

// ----- CryptoNote (Monero / Wownero) -----

export interface CryptonoteFamilyData {
  family: 'cryptonote';
  /**
   * RingCT type byte at the protocol level. 6 = ClsagBulletproofPlus
   * (Monero post-Fluorine); 8 = WowneroClsagBulletproofPlus.
   */
  rctType: 6 | 8;
  /** Mandatory ring size (decoy count + 1 real input). */
  ringSize: number;
  features: {
    /** Subaddresses (modern XMR / WOW). */
    subaddresses: boolean;
    /**
     * Integrated addresses (legacy: address + 8-byte payment ID).
     * XMR removed support; some wallets still display them. WOW retains.
     */
    integratedAddresses: boolean;
    /**
     * View tags (XMR Salvium hardfork onward — speeds up output scan).
     */
    viewTags: boolean;
  };
}

// ----- Mimblewimble (Grin) -----

export interface MimblewimbleFamilyData {
  family: 'mimblewimble';
  /**
   * Slate version this chain currently uses on mainnet. v4 for Grin
   * today; bump to v5 when Grin upgrades.
   */
  slateVersion: 4 | 5;
  features: {
    /** ed25519-signed payment receipts (Grin "payment proofs"). */
    paymentProofs: boolean;
    /** No-Recent-Duplicate kernels (relative timelocks, atomic swaps). */
    nrdKernels: boolean;
    /** Slatepack ASCII-armored binary serialization. */
    slatepackCodec: boolean;
  };
}

export type FamilyData = UtxoFamilyData | CryptonoteFamilyData | MimblewimbleFamilyData;

// ============================================================================
// Networks
// ============================================================================

/**
 * Standard network names. Most chains have at least mainnet; testnets
 * are optional and registered alongside mainnet when the wallet
 * supports them.
 */
export type NetworkName = 'mainnet' | 'testnet' | 'regtest' | 'floonet';

export interface NetworkInfo {
  /** Stable name; matches the leaf of API requests like `btc-testnet`. */
  name: NetworkName;
  /** SLIP-0044 BIP44 coin type used for derivation on this network. */
  bip44CoinType: number;
  /**
   * Default BIP32 derivation path for the *first* receive address.
   * Used by the wallet bootstrap; subsequent addresses are derived
   * by incrementing the leaf.
   *
   * For non-BIP32 chains (Grin), this is a sentinel value the
   * adapter ignores.
   */
  defaultDerivationPath: string;
  /** True iff this is a real, value-bearing network. */
  isProduction: boolean;
}

// ============================================================================
// Swap support
// ============================================================================

/**
 * Cross-chain swap routing options for an asset.
 *
 * - `thorchain` — Aggregator (THORChain), v0.3 swap implementation.
 * - `native`    — Peer-to-peer adaptor-signature swap, v0.4+ work
 *                 (`crates/swap-core/`).
 *
 * An asset can support multiple. The Swap UI's aggregator-vs-native
 * toggle filters by which routes both sides of a pair support.
 */
export type SwapRoute = 'thorchain' | 'native';

// ============================================================================
// Top-level definition
// ============================================================================

export interface AssetDefinition {
  // ----- Identity -----

  /** Stable lowercase id. Map key in the registry. */
  id: AssetId;

  /** Human-readable name. "Bitcoin", "Litecoin", "Wownero". */
  displayName: string;

  /** Ticker symbol. Uppercase. "BTC", "LTC", "WOW". */
  ticker: string;

  /**
   * Number of decimal places between atomic units and display units.
   * BTC/LTC = 8, XMR = 12, WOW = 11, Grin = 9.
   */
  decimals: number;

  /**
   * Stable icon identifier — typically the same as `id`. The
   * consumer (extension popup, mobile app) maps this to an actual
   * file path.
   */
  iconKey: string;

  // ----- Behavioral classification -----

  /** How the user sends funds. See `AddressKind`. */
  addressKind: AddressKind;

  /** Chain family + family-specific feature flags. */
  family: FamilyData;

  // ----- Network metadata -----

  /**
   * Networks this asset supports, indexed by name. Always includes
   * `mainnet`; testnet etc. are optional.
   */
  networks: Readonly<Partial<Record<NetworkName, NetworkInfo>>>;

  /** Network used for new-wallet bootstrap. Almost always `mainnet`. */
  defaultNetwork: NetworkName;

  // ----- Behavior -----

  /**
   * Confirmations required before a received tx is considered
   * claimable / spendable. BTC=0 (zeroconf), WOW=4, XMR=10,
   * Grin=10.
   *
   * The backend enforces these for social tipping (preventing
   * claim before the funding tx is final); the UI displays a
   * progress indicator while a tip is "still confirming."
   */
  confirmationsRequired: number;

  /**
   * Cross-chain swap routes available for this asset.
   *
   * v0.3 ships THORChain (aggregator); v0.4+ adds native P2P
   * adaptor-signature swaps. Empty array means "swap not yet
   * supported for this asset" — the asset is still tip-able and
   * sendable, just not in the Swap tab.
   */
  swapRoutes: ReadonlyArray<SwapRoute>;

  /**
   * Whether the wallet supports social tipping for this asset.
   * Currently every asset does; included as a flag so a future
   * registered chain can opt out without a separate code path.
   */
  socialTipping: boolean;
}
