/**
 * The chain provider registry: chain -> provider, defaulting every chain to the
 * Smirk backend. This is the swap point for the future "server options" UI:
 * `setUtxo('btc', new ElectrumProvider(...))` repoints one chain to a direct
 * source while the rest keep using the backend.
 *
 * The default registry closes over the shared `api` singleton. Because providers
 * hold the api REFERENCE (not its base URL), `initSmirkApi`/`setBaseUrl` flows
 * through automatically; the registry does not need rebuilding when the backend
 * URL changes.
 *
 * Reachable two ways, matching the codebase's two api-acquisition patterns:
 *   - singleton consumers: `import { chainProviders } from '@smirk/core'`
 *   - injected consumers (execute-approval deps, wallet-flow api param):
 *     `createChainProviders(injectedApi)` so unit tests keep mocking.
 */
import { api } from '../api';
import type { SmirkApi } from '../api';
import type { GrinChainProvider, LwsAsset, LwsChainProvider, UtxoAsset, UtxoChainProvider } from './provider';
import { SmirkGrinProvider, SmirkLwsProvider, SmirkUtxoProvider } from './smirk-backend';

export interface ChainProviderRegistry {
  utxo(asset: UtxoAsset): UtxoChainProvider;
  lws(asset: LwsAsset): LwsChainProvider;
  grin(): GrinChainProvider;
  /** Server-options swaps. Out of scope for the default path; a settings UI
   *  with per-chain endpoint validation drives these later. */
  setUtxo(asset: UtxoAsset, provider: UtxoChainProvider): void;
  setLws(asset: LwsAsset, provider: LwsChainProvider): void;
  setGrin(provider: GrinChainProvider): void;
}

export function createChainProviders(client: SmirkApi): ChainProviderRegistry {
  const utxo: Record<UtxoAsset, UtxoChainProvider> = {
    btc: new SmirkUtxoProvider('btc', client),
    ltc: new SmirkUtxoProvider('ltc', client),
  };
  const lws: Record<LwsAsset, LwsChainProvider> = {
    xmr: new SmirkLwsProvider('xmr', client),
    wow: new SmirkLwsProvider('wow', client),
  };
  let grin: GrinChainProvider = new SmirkGrinProvider(client);

  return {
    utxo: (asset) => utxo[asset],
    lws: (asset) => lws[asset],
    grin: () => grin,
    setUtxo: (asset, provider) => {
      utxo[asset] = provider;
    },
    setLws: (asset, provider) => {
      lws[asset] = provider;
    },
    setGrin: (provider) => {
      grin = provider;
    },
  };
}

/** Default registry over the shared backend singleton. */
export const chainProviders: ChainProviderRegistry = createChainProviders(api);
