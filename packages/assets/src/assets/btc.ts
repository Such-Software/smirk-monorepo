import type { AssetDefinition } from '../types';

/**
 * Bitcoin — UTXO, native segwit by default, taproot opt-in.
 *
 * Smirk supports BTC mainnet and testnet (testnet for dev / staging
 * only — no production tipping). Default address kind is P2WPKH
 * (BIP84) so users get short, modern segwit addresses. P2TR (BIP86)
 * is supported via the asset's address-type picker; once Schnorr-
 * signed taproot tipping has more wallet support we'll consider
 * promoting it to default.
 *
 * Ring-CT and slate considerations don't apply (UTXO chain).
 *
 * Confirmations: 0 — we treat first-seen as good for tipping.
 * Backend's mempool tracking handles double-spend monitoring.
 */
export const btc: AssetDefinition = {
  id: 'btc',
  displayName: 'Bitcoin',
  ticker: 'BTC',
  decimals: 8,
  iconKey: 'btc',

  addressKind: 'address',

  family: {
    family: 'utxo',
    defaultAddressType: 'p2wpkh',
    supportedAddressTypes: ['p2wpkh', 'p2tr'],
    features: {
      segwit: true,
      taproot: true,
      mweb: false,
      psbt: true,
    },
  },

  networks: {
    mainnet: {
      name: 'mainnet',
      bip44CoinType: 0,
      defaultDerivationPath: "m/84'/0'/0'/0/0",
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
