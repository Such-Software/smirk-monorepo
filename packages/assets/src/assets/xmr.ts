import type { AssetDefinition } from '../types';

/**
 * Monero — CryptoNote chain, RingCT type 6 (`ClsagBulletproofPlus`),
 * 16-member rings.
 *
 * 12 atomic-units-per-XMR decimal places (1 XMR = 1e12 piconero).
 *
 * Confirmations: 10. Monero's reorg risk is meaningfully nonzero
 * because of its smaller hashpower vs Bitcoin; 10 confirmations
 * (~20 minutes) is the conservative tipping threshold we enforce.
 *
 * Integrated addresses: removed in mainnet protocol but legacy data
 * still exists. Subaddresses + view tags (Salvium hard fork onward)
 * are in active use.
 */
export const xmr: AssetDefinition = {
  id: 'xmr',
  displayName: 'Monero',
  ticker: 'XMR',
  decimals: 12,
  displayDecimals: 4,
  iconKey: 'xmr',

  addressKind: 'address',

  family: {
    family: 'cryptonote',
    rctType: 6,
    ringSize: 16,
    features: {
      subaddresses: true,
      integratedAddresses: false,
      viewTags: true,
    },
  },

  networks: {
    mainnet: {
      name: 'mainnet',
      bip44CoinType: 128,
      // v3 derivation path — see packages/core/src/hd.ts:
      // BIP32 secp256k1 leaf at m/44'/128'/0'/0/0, reduced mod l.
      // v1 + v2 paths are kept in code for legacy-wallet sweep but
      // are not part of the canonical asset definition.
      defaultDerivationPath: "m/44'/128'/0'/0/0",
      isProduction: true,
    },
  },

  defaultNetwork: 'mainnet',

  confirmationsRequired: 10,

  swapRoutes: ['thorchain'],

  socialTipping: true,
  sendable: true,
  receivable: true,
  dappBridge: true,
  defaultVisible: true,
};
