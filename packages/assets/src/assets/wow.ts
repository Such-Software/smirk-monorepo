import type { AssetDefinition } from '../types';

/**
 * Wownero — CryptoNote chain, RingCT type 8
 * (`WowneroClsagBulletproofPlus`), 22-member rings.
 *
 * 11 atomic-units-per-WOW decimal places (1 WOW = 1e11 atomic).
 * The "11 not 12" gotcha catches wallets — gets a regression test
 * in the registry suite.
 *
 * Confirmations: 4. WOW's faster blocks (~2 min) and the wallet's
 * lower-value tipping use case justify a more permissive threshold
 * than XMR. The backend enforces this so claim flows match.
 *
 * Wownero retains integrated addresses (XMR removed them) and is
 * still rolling out view tags as part of its current hardfork
 * trajectory. Watch for that flag bumping when WOW upgrades.
 *
 * Swap routes: not currently routable through THORChain. Native
 * swap support (`crates/swap-core/`, v0.4+) is the primary swap
 * path for WOW.
 */
export const wow: AssetDefinition = {
  id: 'wow',
  displayName: 'Wownero',
  ticker: 'WOW',
  decimals: 11,
  iconKey: 'wow',

  addressKind: 'address',

  family: {
    family: 'cryptonote',
    rctType: 8,
    ringSize: 22,
    features: {
      subaddresses: true,
      integratedAddresses: true,
      viewTags: false,
    },
  },

  networks: {
    mainnet: {
      name: 'mainnet',
      bip44CoinType: 2086,
      defaultDerivationPath: "m/44'/2086'/0'/0/0",
      isProduction: true,
    },
  },

  defaultNetwork: 'mainnet',

  confirmationsRequired: 4,

  // Aggregator routes will get added when WOW is supported on
  // bridges; native (P2P) is the v0.4+ primary path.
  swapRoutes: [],

  socialTipping: true,
};
