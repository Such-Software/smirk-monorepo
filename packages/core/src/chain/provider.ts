/**
 * ChainProvider: the chain-data plane of the wallet.
 *
 * A provider answers "where are my coins and how do I move them" for ONE chain:
 * balance, spendable outputs, broadcast, history, height, fee. Platform features
 * (tips, swaps, slatepack relay, auth, social, prices) are NOT here; they stay on
 * `api.*`. The default provider for every chain delegates to the Smirk backend,
 * so the wallet behaves exactly as before; a later "server options" UI can swap a
 * single chain to a direct source (electrum, monero-lws, grin-lws).
 *
 * Chains diverge too hard for one signature, so there is a provider interface per
 * model (utxo / ring-CT lws / mimblewimble). Each shares a small base.
 */
import type { ApiResponse } from '../api/client';
import type {
  FeeEstimate,
  FeeModel,
  GrinBroadcastResult,
  GrinScanResult,
  LwsBalance,
  LwsDeactivateResult,
  LwsHistory,
  LwsProvisionResult,
  LwsRandomOuts,
  LwsRegisterResult,
  LwsSubmitResult,
  LwsUnspent,
  UtxoAddressRef,
  UtxoBalance,
  UtxoBroadcastResult,
  UtxoHistory,
  UtxoListing,
} from './types';

export type UtxoAsset = 'btc' | 'ltc';
export type LwsAsset = 'xmr' | 'wow';
export type ChainAsset = UtxoAsset | LwsAsset | 'grin';

/** How a chain models ownership. Drives coin selection + the "account = one
 *  notional output" handling for account chains (eth, when added). */
export type ChainModel = 'utxo' | 'ringct' | 'mw-commitment' | 'account';

/** Static facts about a chain, used to drive UI and guard optional methods.
 *  A direct provider (electrum, lws) reports the same capabilities so callers
 *  branch on the capability, never on "which backend". */
export interface ChainCapabilities {
  model: ChainModel;
  feeModel: FeeModel;
  /** ring-CT: a view key is required to read balances/outputs. */
  requiresViewKey: boolean;
  /** ring-CT (registerLws): the server must know the account before it can
   *  serve its data. Grin does NOT require this on v3 — its key registration
   *  (POST /keys) is discovery-only, not a precondition for the rewind scan. */
  requiresRegistration: boolean;
  /** ring-CT: spends need decoy/ring members (getRandomOutputs). */
  hasDecoys: boolean;
  /** grin: seed-only recovery via view-key rewind scan (`scan`). */
  hasRecoveryScan: boolean;
  /** grin (legacy): whether outputs live in a server-side store with a
   *  lock/spend lifecycle. Always false on v3 — the client owns output state
   *  and reads it from `scan` each call. */
  serverSideOutputStore: boolean;
}

/** Common to every provider regardless of model. */
export interface BaseChainProvider {
  readonly asset: ChainAsset;
  readonly capabilities: ChainCapabilities;
  /** Per-chain tip height. */
  getHeight(): Promise<ApiResponse<{ height: number | null }>>;
  /** Fee estimate in the chain's fee model; never "unsupported". */
  estimateFee(): Promise<ApiResponse<FeeEstimate>>;
}

/** UTXO chains (btc, ltc): public addresses, an indexer serves balance/utxos. */
export interface UtxoChainProvider extends BaseChainProvider {
  readonly asset: UtxoAsset;
  getBalance(address: string): Promise<ApiResponse<UtxoBalance>>;
  listOutputs(address: string): Promise<ApiResponse<UtxoListing>>;
  broadcast(txHex: string): Promise<ApiResponse<UtxoBroadcastResult>>;
  getHistory(address: string): Promise<ApiResponse<UtxoHistory>>;

  // --- Multi-address (BIP84 gap-limit fresh addresses; gated OFF by default) ---
  // These target the backend's FEATURE_UTXO_MULTI_ADDRESS routes, which 404
  // when the backend feature is off. Callers only use them when the client
  // flag ENABLE_BTCLTC_FRESH_ADDRS is on; with it off the single-address
  // methods above are the only ones invoked, so behavior is unchanged.

  /** Aggregate balance across several owned addresses (one round-trip). */
  getBalanceMulti(addresses: string[]): Promise<ApiResponse<UtxoBalance>>;
  /**
   * UTXOs across several owned addresses. Each returned {@link UtxoEntry} is
   * TAGGED with its owning `address` + `masterPath` (the path re-attached
   * client-side from `refs`, never server-derived — money gate G9).
   */
  listOutputsMulti(refs: UtxoAddressRef[]): Promise<ApiResponse<UtxoListing>>;
  /** Aggregate history across several owned addresses. */
  getHistoryMulti(addresses: string[]): Promise<ApiResponse<UtxoHistory>>;
}

/** Ring-CT chains (xmr, wow): a view key + per-output cryptographic scanning. */
export interface LwsChainProvider extends BaseChainProvider {
  readonly asset: LwsAsset;
  getBalance(address: string, viewKey: string): Promise<ApiResponse<LwsBalance>>;
  listOutputs(address: string, viewKey: string): Promise<ApiResponse<LwsUnspent>>;
  // Only the signed tx is sent. The recipient address + amount are deliberately
  // NOT transmitted: the LWS needs just the raw tx to broadcast, and sending them
  // would hand the operator a sender<->recipient<->amount link on every send.
  broadcast(txHex: string): Promise<ApiResponse<LwsSubmitResult>>;
  getHistory(address: string, viewKey: string): Promise<ApiResponse<LwsHistory>>;
  getRandomOutputs(count: number): Promise<ApiResponse<LwsRandomOuts>>;
  registerAccount(
    userId: string,
    address: string,
    viewKey: string,
    startHeight?: number,
    /**
     * Account-0 minor subaddress indices to provision alongside registration.
     * Omitted by every caller unless the ENABLE_SUBADDRESS_RECEIVE client flag
     * is on, so registration is unchanged by default.
     */
    subaddrCount?: number,
  ): Promise<ApiResponse<LwsRegisterResult>>;
  deactivateAccount(address: string): Promise<ApiResponse<LwsDeactivateResult>>;

  /**
   * Provision account-0 minor subaddress indices `[0 .. maxMinor]` at the
   * server, and report back the ceiling it actually provisioned.
   *
   * OPTIONAL on purpose: a direct / self-hosted provider may not implement
   * provisioning at all. Callers MUST treat its absence as "cannot raise the
   * ceiling" and refuse to issue a new subaddress (money gate G4) rather than
   * assume a default. An unprovisioned subaddress is not scanned by the LWS,
   * so funds sent to it never appear.
   */
  provisionSubaddrs?(
    userId: string,
    address: string,
    viewKey: string,
    maxMinor: number,
  ): Promise<ApiResponse<LwsProvisionResult>>;
}

/** Mimblewimble (grin): no addresses, no amounts, no server-side store. Balance
 *  + spendable UTXOs come from a view-key rewind `scan` (the source of truth);
 *  the client owns output state via a local pending overlay. */
export interface GrinChainProvider extends BaseChainProvider {
  readonly asset: 'grin';
  /**
   * Rewind the UTXO set with the wallet's view-only `rewindHash` and return its
   * currently-unspent outputs. Source of truth for balance + spendable inputs;
   * stores nothing server-side. `scan` IS recovery (rewinds the whole set).
   */
  scan(params: {
    rewindHash: string;
    startHeight?: number | undefined;
    restorePowNonce?: number | undefined;
  }): Promise<ApiResponse<GrinScanResult>>;
  /** Relay a finalized tx to the node. Backend reads only `{ tx }`. */
  broadcast(params: { tx: object }): Promise<ApiResponse<GrinBroadcastResult>>;
}

export type AnyChainProvider = UtxoChainProvider | LwsChainProvider | GrinChainProvider;
