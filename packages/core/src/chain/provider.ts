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
  GrinBalance,
  GrinBroadcastResult,
  GrinHistory,
  GrinOutputListing,
  GrinRecordResult,
  GrinScanResult,
  LwsBalance,
  LwsDeactivateResult,
  LwsHistory,
  LwsRandomOuts,
  LwsRegisterResult,
  LwsSubmitResult,
  LwsUnspent,
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
  /** ring-CT (registerLws) + grin (registerGrinAddress): the server must know
   *  the account before it can serve its data. */
  requiresRegistration: boolean;
  /** ring-CT: spends need decoy/ring members (getRandomOutputs). */
  hasDecoys: boolean;
  /** grin: seed-only recovery by rangeproof rewind (scanUnspent). */
  hasRecoveryScan: boolean;
  /** grin: outputs live in a server-side store with a lock/spend lifecycle. */
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
}

/** Ring-CT chains (xmr, wow): a view key + per-output cryptographic scanning. */
export interface LwsChainProvider extends BaseChainProvider {
  readonly asset: LwsAsset;
  getBalance(address: string, viewKey: string): Promise<ApiResponse<LwsBalance>>;
  listOutputs(address: string, viewKey: string): Promise<ApiResponse<LwsUnspent>>;
  broadcast(
    txHex: string,
    recipientAddress?: string,
    amount?: number,
    txHash?: string,
  ): Promise<ApiResponse<LwsSubmitResult>>;
  getHistory(address: string, viewKey: string): Promise<ApiResponse<LwsHistory>>;
  getRandomOutputs(count: number): Promise<ApiResponse<LwsRandomOuts>>;
  registerAccount(
    userId: string,
    address: string,
    viewKey: string,
    startHeight?: number,
  ): Promise<ApiResponse<LwsRegisterResult>>;
  deactivateAccount(address: string): Promise<ApiResponse<LwsDeactivateResult>>;
}

/** Mimblewimble (grin): no addresses, no amounts; rangeproof rewind + a
 *  server-side output store with an explicit lock/spend lifecycle. */
export interface GrinChainProvider extends BaseChainProvider {
  readonly asset: 'grin';
  getBalance(userId: string): Promise<ApiResponse<GrinBalance>>;
  listOutputs(userId: string): Promise<ApiResponse<GrinOutputListing>>;
  getHistory(userId: string): Promise<ApiResponse<GrinHistory>>;
  broadcast(params: {
    userId: string;
    slateId: string;
    tx: object;
    changeOutput?: { keyId: string; nChild: number; amount: number; commitment: string };
  }): Promise<ApiResponse<GrinBroadcastResult>>;
  /** Seed-only recovery: paginated walk of the unspent MMR with rangeproofs. */
  scanUnspent(params: {
    startIndex?: number | undefined;
    startHeight?: number | undefined;
    max?: number | undefined;
  }): Promise<ApiResponse<GrinScanResult>>;
  recordOutput(params: {
    userId: string;
    keyId: string;
    nChild: number;
    amount: number;
    commitment: string;
    txSlateId?: string;
    blockHeight?: number;
    lockHeight?: number;
  }): Promise<ApiResponse<GrinRecordResult>>;
  lockOutputs(params: { userId: string; outputIds: string[]; txSlateId: string }): Promise<ApiResponse<void>>;
  unlockOutputs(params: { userId: string; txSlateId: string }): Promise<ApiResponse<void>>;
  spendOutputs(params: { userId: string; txSlateId: string }): Promise<ApiResponse<void>>;
}

export type AnyChainProvider = UtxoChainProvider | LwsChainProvider | GrinChainProvider;
