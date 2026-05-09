import type { AssetDefinition } from '../types';

/**
 * Litecoin — UTXO, native segwit by default. MWEB support is
 * roadmapped but **not yet implemented** (`features.mweb = false`);
 * once `crates/btc-ext/` (or a sibling `crates/ltc-ext/`) gains
 * MWEB transaction construction, flip this flag and the UI will
 * surface MWEB shielded transactions automatically.
 *
 * Note that LTC's BIP44 coin type is 2 (per SLIP-44), distinct
 * from Bitcoin's 0. Testnet shares testnet coin type 1 with all
 * Bitcoin-family testnets — this is by SLIP-44 convention.
 *
 * Confirmations: 0 — same first-seen treatment as Bitcoin.
 */
export const ltc: AssetDefinition = {
  id: 'ltc',
  displayName: 'Litecoin',
  ticker: 'LTC',
  decimals: 8,
  iconKey: 'ltc',

  addressKind: 'address',

  family: {
    family: 'utxo',
    defaultAddressType: 'p2wpkh',
    supportedAddressTypes: ['p2wpkh'],
    features: {
      segwit: true,
      // Taproot: not active on LTC mainnet at the time of this
      // writing. When activated, also flip in `supportedAddressTypes`.
      taproot: false,
      mweb: false,
      psbt: true,
    },
  },

  networks: {
    mainnet: {
      name: 'mainnet',
      bip44CoinType: 2,
      defaultDerivationPath: "m/84'/2'/0'/0/0",
      isProduction: true,
    },
    testnet: {
      name: 'testnet',
      bip44CoinType: 1,
      defaultDerivationPath: "m/84'/1'/0'/0/0",
      isProduction: false,
    },
  },

  defaultNetwork: 'mainnet',

  confirmationsRequired: 0,

  swapRoutes: ['thorchain'],

  socialTipping: true,
};
