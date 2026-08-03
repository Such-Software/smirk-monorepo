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
import type {
  FeeEstimate,
  LwsProvisionResult,
  UtxoAddressRef,
  UtxoBalance,
  UtxoHistory,
  UtxoListing,
} from './types';

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
  // read balance: scan works from the rewind_hash alone.
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

  // Multi-address delegators. Each forwards to the api's `*_multi` method
  // (FEATURE_UTXO_MULTI_ADDRESS backend routes) and re-maps the envelope into
  // the chain `Utxo*` shape. Only invoked under the ENABLE_BTCLTC_FRESH_ADDRS
  // client flag; unused (and the routes 404) otherwise.
  async getBalanceMulti(addresses: string[]) {
    const asset = this.asset;
    return mapData(
      await this.api.getUtxoBalanceMulti(asset, addresses),
      (d): UtxoBalance => ({
        asset: d.asset,
        // No single canonical address in aggregate mode; expose the empty
        // string so the field stays present (UtxoBalance.address is required).
        address: '',
        confirmed: d.confirmed,
        unconfirmed: d.unconfirmed,
        total: d.total,
      }),
    );
  }
  async listOutputsMulti(refs: UtxoAddressRef[]) {
    const asset = this.asset;
    return mapData(
      await this.api.getUtxosMulti(asset, refs),
      (d): UtxoListing => ({
        asset: d.asset,
        address: '',
        // The api layer already re-attached each UTXO's client-side masterPath
        // from `refs`; carry both tags through unchanged (money gate G9).
        utxos: d.utxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          height: u.height,
          address: u.address,
          masterPath: u.masterPath,
        })),
      }),
    );
  }
  async getHistoryMulti(addresses: string[]) {
    const asset = this.asset;
    return mapData(
      await this.api.getHistoryMulti(asset, addresses),
      (d): UtxoHistory => ({ asset: d.asset, address: '', transactions: d.transactions }),
    );
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
  broadcast(txHex: string) {
    return this.api.submitLwsTx(this.asset, txHex);
  }
  getHistory(address: string, viewKey: string) {
    return this.api.getLwsHistory(this.asset, address, viewKey);
  }
  getRandomOutputs(count: number) {
    return this.api.getRandomOuts(this.asset, count);
  }
  registerAccount(
    userId: string,
    address: string,
    viewKey: string,
    startHeight?: number,
    subaddrCount?: number,
  ) {
    // Call ARITY is preserved when no batch was asked for: this file's contract
    // is that a provider call and the old direct `api` call are identical, and
    // an extra trailing `undefined` is an observable difference to anything
    // inspecting arguments.
    return subaddrCount === undefined
      ? this.api.registerLws(userId, this.asset, address, viewKey, startHeight)
      : this.api.registerLws(userId, this.asset, address, viewKey, startHeight, subaddrCount);
  }
  deactivateAccount(address: string) {
    return this.api.deactivateLws(this.asset, address);
  }
  // Only reached under the ENABLE_SUBADDRESS_RECEIVE client flag; the backend
  // route is itself gated (and 404s when the backend feature is off), which the
  // caller must treat as "ceiling not raised" and refuse to issue.
  async provisionSubaddrs(
    userId: string,
    address: string,
    viewKey: string,
    maxMinor: number,
  ): Promise<ApiResponse<LwsProvisionResult>> {
    return mapData(
      await this.api.provisionSubaddrs(userId, this.asset, address, viewKey, maxMinor),
      (d): LwsProvisionResult => ({ provisionedMinorMax: d.provisioned_minor_max }),
    );
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
