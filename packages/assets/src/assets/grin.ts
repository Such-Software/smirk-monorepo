import type { AssetDefinition } from '../types';

/**
 * Grin — Mimblewimble chain, slate v4 wire format.
 *
 * The `addressKind: 'interactive'` flag is what flips the wallet
 * UI out of the standard address-based send paradigm and into the
 * Slatepack flow. See `docs/UI_DESIGN.md` Principle 3 — Grin gets
 * a Message Center.
 *
 * Decimals: 9 (1 GRIN = 1e9 nanogrin).
 *
 * Slatepack addresses (`grin1…`) are not on-chain addresses —
 * Mimblewimble has no addresses at the consensus layer. The
 * slatepack address is an ed25519 pubkey used for slate encryption
 * and Tor-onion derivation. The asset definition still lists Grin
 * as having a "default derivation path" sentinel, but the
 * canonical Grin derivation goes through `grin-ext`'s
 * `mnemonic_to_extended_private_key` (HMAC-SHA512 with key
 * `"IamVoldemort"` over raw BIP39 entropy — matches grin-wallet
 * and Grim).
 *
 * Confirmations: 10. Like XMR, Grin's reorg risk justifies a
 * conservative tipping threshold.
 *
 * Swap routes: not currently routable through THORChain. Grin↔BTC
 * is a v0.4 native (adaptor signature) swap target.
 */
export const grin: AssetDefinition = {
  id: 'grin',
  displayName: 'Grin',
  ticker: 'GRIN',
  decimals: 9,
  iconKey: 'grin',

  addressKind: 'interactive',

  family: {
    family: 'mimblewimble',
    slateVersion: 4,
    features: {
      paymentProofs: true,
      nrdKernels: true,
      slatepackCodec: true,
    },
  },

  networks: {
    mainnet: {
      name: 'mainnet',
      // Grin doesn't strictly use SLIP-44; 592 is the registered
      // entry but the canonical Grin derivation does not pass
      // through BIP44. Kept here for cross-tooling consistency.
      bip44CoinType: 592,
      // Sentinel — the Grin adapter ignores this and instead
      // uses HMAC-SHA512(IamVoldemort, raw_entropy).
      defaultDerivationPath: 'grin/voldemort',
      isProduction: true,
    },
    floonet: {
      name: 'floonet',
      bip44CoinType: 1,
      defaultDerivationPath: 'grin/voldemort',
      isProduction: false,
    },
  },

  defaultNetwork: 'mainnet',

  confirmationsRequired: 10,

  swapRoutes: [],

  socialTipping: true,
};
