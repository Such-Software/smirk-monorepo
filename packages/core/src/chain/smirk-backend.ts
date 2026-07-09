/**
 * Default chain providers: thin delegators over the Smirk backend `api`.
 *
 * Each method forwards to the EXACT existing `api.*` method, so the request, its
 * retry policy (retryable vs plain), and its response envelope are inherited
 * unchanged. This is the behaviour-preservation contract: a provider call and the
 * old direct `api` call are byte-for-byte identical. Do not "normalise" retry
 * here, and do not reshape responses (the lifted types are structurally equal to
 * the api's inline shapes).
 *
 * The two synthesised reads, getHeight and estimateFee, are net-new surface with
 * no consumers yet; they wrap existing data (the shared heights map; the utxo fee
 * endpoint) and declare each chain's fee model.
 */
import type { ApiResponse } from '../api/client';
import type { SmirkApi } from '../api';
import type {
  ChainAsset,
  ChainCapabilities,
  GrinChainProvider,
  LwsAsset,
  LwsChainProvider,
  UtxoAsset,
  UtxoChainProvider,
} from './provider';
import type { FeeEstimate } from './types';

const UTXO_CAPS: ChainCapabilities = {
  model: 'utxo',
  feeModel: 'rate-estimate',
  requiresViewKey: false,
  requiresRegistration: false,
  hasDecoys: false,
  hasRecoveryScan: false,
  serverSideOutputStore: false,
};

const LWS_CAPS: ChainCapabilities = {
  model: 'ringct',
  feeModel: 'param-derived',
  requiresViewKey: true,
  requiresRegistration: true,
  hasDecoys: true,
  hasRecoveryScan: false,
  serverSideOutputStore: false,
};

const GRIN_CAPS: ChainCapabilities = {
  model: 'mw-commitment',
  feeModel: 'formula',
  requiresViewKey: false,
  // v3 grin key registration is discovery-only (POST /keys), not required to
  // read balance — scan works from the rewind_hash alone.
  requiresRegistration: false,
  hasDecoys: false,
  hasRecoveryScan: true,
  // No server-side output store on v3; the client owns output state via scan.
  serverSideOutputStore: false,
};

/** Map a response's data while preserving its envelope (status/error/code), in a
 *  way that satisfies exactOptionalPropertyTypes. When there is no data (error
 *  case), the envelope passes through unchanged. */
function mapData<A, B>(r: ApiResponse<A>, f: (a: A) => B): ApiResponse<B> {
  return r.data === undefined ? (r as unknown as ApiResponse<B>) : { ...r, data: f(r.data) };
}

/** Per-chain tip from the shared heights map. getBlockchainHeights has no other
 *  consumers, so this is additive, not a reroute. */
async function heightFromBackend(
  api: SmirkApi,
  asset: ChainAsset,
): Promise<ApiResponse<{ height: number | null }>> {
  return mapData(await api.getBlockchainHeights(), (h) => ({ height: h[asset] ?? null }));
}

export class SmirkUtxoProvider implements UtxoChainProvider {
  readonly capabilities = UTXO_CAPS;
  constructor(
    readonly asset: UtxoAsset,
    private readonly api: SmirkApi,
  ) {}

  getBalance(address: string) {
    return this.api.getUtxoBalance(this.asset, address);
  }
  listOutputs(address: string) {
    return this.api.getUtxos(this.asset, address);
  }
  broadcast(txHex: string) {
    return this.api.broadcastTx(this.asset, txHex);
  }
  getHistory(address: string) {
    return this.api.getHistory(this.asset, address);
  }
  getHeight() {
    return heightFromBackend(this.api, this.asset);
  }
  async estimateFee(): Promise<ApiResponse<FeeEstimate>> {
    return mapData(
      await this.api.estimateFee(this.asset),
      (d): FeeEstimate => ({ model: 'rate-estimate', fast: d.fast, normal: d.normal, slow: d.slow }),
    );
  }
}

export class SmirkLwsProvider implements LwsChainProvider {
  readonly capabilities = LWS_CAPS;
  constructor(
    readonly asset: LwsAsset,
    private readonly api: SmirkApi,
  ) {}

  getBalance(address: string, viewKey: string) {
    return this.api.getLwsBalance(this.asset, address, viewKey);
  }
  listOutputs(address: string, viewKey: string) {
    return this.api.getUnspentOuts(this.asset, address, viewKey);
  }
  broadcast(txHex: string, recipientAddress?: string, amount?: number, txHash?: string) {
    return this.api.submitLwsTx(this.asset, txHex, recipientAddress, amount, txHash);
  }
  getHistory(address: string, viewKey: string) {
    return this.api.getLwsHistory(this.asset, address, viewKey);
  }
  getRandomOutputs(count: number) {
    return this.api.getRandomOuts(this.asset, count);
  }
  registerAccount(userId: string, address: string, viewKey: string, startHeight?: number) {
    return this.api.registerLws(userId, this.asset, address, viewKey, startHeight);
  }
  deactivateAccount(address: string) {
    return this.api.deactivateLws(this.asset, address);
  }
  getHeight() {
    return heightFromBackend(this.api, this.asset);
  }
  // The ring-CT fee comes from per_byte_fee/fee_mask on listOutputs; estimateFee
  // just declares the model so callers know to read it there.
  async estimateFee(): Promise<ApiResponse<FeeEstimate>> {
    return { data: { model: 'param-derived' }, status: 200 };
  }
}

export class SmirkGrinProvider implements GrinChainProvider {
  readonly asset = 'grin' as const;
  readonly capabilities = GRIN_CAPS;
  constructor(private readonly api: SmirkApi) {}

  scan(params: {
    rewindHash: string;
    startHeight?: number | undefined;
    restorePowNonce?: number | undefined;
  }) {
    return this.api.scanGrin(params);
  }
  broadcast(params: { tx: object }) {
    return this.api.broadcastGrinTransaction(params);
  }
  getHeight() {
    return heightFromBackend(this.api, 'grin');
  }
  // Grin fee is a deterministic formula computed client-side from tx weight.
  async estimateFee(): Promise<ApiResponse<FeeEstimate>> {
    return { data: { model: 'formula' }, status: 200 };
  }
}
