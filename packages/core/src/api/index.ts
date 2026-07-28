/**
 * Smirk API client — mixes all domain-specific method groups into a
 * single class.
 *
 * Most callers should import the singleton `api`:
 *
 * ```ts
 * import { api } from '@smirk/core';
 * api.setAccessToken('...');
 * const tip = await api.getTip(linkId);
 * ```
 *
 * Construct your own `SmirkApi(baseUrl)` only when you need to point at
 * a non-default backend (test fixtures, local dev).
 */

import { ApiClient, ApiResponse } from './client';
import { createAuthMethods, AuthMethods } from './auth';
import { createKeysMethods, KeysMethods } from './keys';
import { createTipsMethods, TipsMethods } from './tips';
import { createSocialMethods, SocialMethods } from './social';
import { createWalletUtxoMethods, WalletUtxoMethods } from './wallet-utxo';
import { createWalletLwsMethods, WalletLwsMethods } from './wallet-lws';
import { createGrinMethods, GrinMethods } from './grin';
import { createSwapMethods, SwapMethods } from './swap';
import type { BackendCapabilities, PremiumStatus } from './capabilities';

export type { ApiResponse, WalletApiStyle } from './client';
export { ApiClient } from './client';
export * from './parse';
export * from './capabilities';
export * from './capabilities-cache';
export * from './backend-config';

export type { AuthMethods } from './auth';
export type { KeysMethods } from './keys';
export type { TipsMethods } from './tips';
export type {
  SocialMethods,
  SocialLookupResponse,
  CreateSocialTipRequest,
  CreateSocialTipResponse,
  ClaimableTip,
  SentTip,
  ReceivedTip,
  PublicTipInfo,
} from './social';
export type { WalletUtxoMethods, TaggedUtxo } from './wallet-utxo';
// The batch cap lives with the client that enforces it, and is re-exported here
// so hosts and tests reference ONE constant rather than each hardcoding 32.
export { UTXO_MULTI_MAX_ADDRESSES } from './wallet-utxo';
export type { WalletLwsMethods } from './wallet-lws';
export type { GrinMethods } from './grin';
export type { SwapMethods, SwapRecord, CreateSwapPayload } from './swap';

/**
 * Combined Smirk API client. Implements every domain method group;
 * subclass the underlying `ApiClient` for bearer-token auth and retry.
 */
export class SmirkApi
  extends ApiClient
  implements
    AuthMethods,
    KeysMethods,
    TipsMethods,
    Omit<SocialMethods, 'getReceivedTips'>,
    WalletUtxoMethods,
    WalletLwsMethods,
    GrinMethods,
    SwapMethods
{
  // Auth
  telegramLogin: AuthMethods['telegramLogin'];
  refreshToken: AuthMethods['refreshToken'];
  extensionRegister: AuthMethods['extensionRegister'];
  createPaymentInvoice: AuthMethods['createPaymentInvoice'];
  checkRestore: AuthMethods['checkRestore'];
  powChallenge: AuthMethods['powChallenge'];
  nostrLogin: AuthMethods['nostrLogin'];
  linkNostr: AuthMethods['linkNostr'];
  nostrRegister: AuthMethods['nostrRegister'];
  getMe: AuthMethods['getMe'];

  // Keys
  registerKey: KeysMethods['registerKey'];
  getUserKeys: KeysMethods['getUserKeys'];
  getUserKeyForAsset: KeysMethods['getUserKeyForAsset'];

  // Link tips
  createTip: TipsMethods['createTip'];
  getTip: TipsMethods['getTip'];
  getTipStatus: TipsMethods['getTipStatus'];
  claimTip: TipsMethods['claimTip'];
  getSentTips: TipsMethods['getSentTips'];
  getReceivedTips: TipsMethods['getReceivedTips'];

  // Social tips — note: SocialMethods.getReceivedTips is renamed to
  // getReceivedSocialTips here because TipsMethods already exposes
  // getReceivedTips for link tips.
  lookupSocial: SocialMethods['lookupSocial'];
  lookupSmirkName: SocialMethods['lookupSmirkName'];
  setMySmirkUsername: SocialMethods['setMySmirkUsername'];
  getMySmirkUsername: SocialMethods['getMySmirkUsername'];
  getMyLinkedSocials: SocialMethods['getMyLinkedSocials'];
  createSocialTip: SocialMethods['createSocialTip'];
  attachSocialTipFunding: SocialMethods['attachSocialTipFunding'];
  cancelSocialTip: SocialMethods['cancelSocialTip'];
  getClaimableTips: SocialMethods['getClaimableTips'];
  getReceivedSocialTips: SocialMethods['getReceivedTips'];
  getSentSocialTips: SocialMethods['getSentSocialTips'];
  claimSocialTip: SocialMethods['claimSocialTip'];
  clawbackSocialTip: SocialMethods['clawbackSocialTip'];
  confirmTipSweep: SocialMethods['confirmTipSweep'];
  getPublicSocialTip: SocialMethods['getPublicSocialTip'];

  // Wallet UTXO (BTC/LTC)
  getUtxoBalance: WalletUtxoMethods['getUtxoBalance'];
  getUtxos: WalletUtxoMethods['getUtxos'];
  broadcastTx: WalletUtxoMethods['broadcastTx'];
  getHistory: WalletUtxoMethods['getHistory'];
  estimateFee: WalletUtxoMethods['estimateFee'];
  getUtxoBalanceMulti: WalletUtxoMethods['getUtxoBalanceMulti'];
  getUtxosMulti: WalletUtxoMethods['getUtxosMulti'];
  getHistoryMulti: WalletUtxoMethods['getHistoryMulti'];

  // Wallet LWS (XMR/WOW)
  getLwsBalance: WalletLwsMethods['getLwsBalance'];
  getUnspentOuts: WalletLwsMethods['getUnspentOuts'];
  getRandomOuts: WalletLwsMethods['getRandomOuts'];
  submitLwsTx: WalletLwsMethods['submitLwsTx'];
  getLwsHistory: WalletLwsMethods['getLwsHistory'];
  registerLws: WalletLwsMethods['registerLws'];
  deactivateLws: WalletLwsMethods['deactivateLws'];
  provisionSubaddrs: WalletLwsMethods['provisionSubaddrs'];

  // Grin (non-custodial: scan is the source of truth; no server output store)
  scanGrin: GrinMethods['scanGrin'];
  getGrinAddressUser: GrinMethods['getGrinAddressUser'];
  broadcastGrinTransaction: GrinMethods['broadcastGrinTransaction'];
  createGrinRelay: GrinMethods['createGrinRelay'];
  getGrinPendingSlatepacks: GrinMethods['getGrinPendingSlatepacks'];
  signGrinSlatepack: GrinMethods['signGrinSlatepack'];
  finalizeGrinSlatepack: GrinMethods['finalizeGrinSlatepack'];
  cancelGrinSlatepack: GrinMethods['cancelGrinSlatepack'];

  // Swap bookkeeping (Trocador)
  createSwap: SwapMethods['createSwap'];
  getSwap: SwapMethods['getSwap'];
  listSwaps: SwapMethods['listSwaps'];

  constructor(baseUrl?: string) {
    super(baseUrl);

    const auth = createAuthMethods(this);
    const keys = createKeysMethods(this);
    const tips = createTipsMethods(this);
    const social = createSocialMethods(this);
    const utxo = createWalletUtxoMethods(this);
    const lws = createWalletLwsMethods(this);
    const grin = createGrinMethods(this);
    const swap = createSwapMethods(this);

    this.telegramLogin = auth.telegramLogin;
    this.refreshToken = auth.refreshToken;
    this.extensionRegister = auth.extensionRegister;
    this.createPaymentInvoice = auth.createPaymentInvoice;
    this.checkRestore = auth.checkRestore;
    this.powChallenge = auth.powChallenge;
    this.nostrLogin = auth.nostrLogin;
    this.linkNostr = auth.linkNostr;
    this.nostrRegister = auth.nostrRegister;
    this.getMe = auth.getMe;

    this.registerKey = keys.registerKey;
    this.getUserKeys = keys.getUserKeys;
    this.getUserKeyForAsset = keys.getUserKeyForAsset;

    this.createTip = tips.createTip;
    this.getTip = tips.getTip;
    this.getTipStatus = tips.getTipStatus;
    this.claimTip = tips.claimTip;
    this.getSentTips = tips.getSentTips;
    this.getReceivedTips = tips.getReceivedTips;

    this.lookupSocial = social.lookupSocial;
    this.lookupSmirkName = social.lookupSmirkName;
    this.setMySmirkUsername = social.setMySmirkUsername;
    this.getMySmirkUsername = social.getMySmirkUsername;
    this.getMyLinkedSocials = social.getMyLinkedSocials;
    this.createSocialTip = social.createSocialTip;
    this.attachSocialTipFunding = social.attachSocialTipFunding;
    this.cancelSocialTip = social.cancelSocialTip;
    this.getClaimableTips = social.getClaimableTips;
    this.getReceivedSocialTips = social.getReceivedTips;
    this.getSentSocialTips = social.getSentSocialTips;
    this.claimSocialTip = social.claimSocialTip;
    this.clawbackSocialTip = social.clawbackSocialTip;
    this.confirmTipSweep = social.confirmTipSweep;
    this.getPublicSocialTip = social.getPublicSocialTip;

    this.getUtxoBalance = utxo.getUtxoBalance;
    this.getUtxos = utxo.getUtxos;
    this.broadcastTx = utxo.broadcastTx;
    this.getHistory = utxo.getHistory;
    this.estimateFee = utxo.estimateFee;
    this.getUtxoBalanceMulti = utxo.getUtxoBalanceMulti;
    this.getUtxosMulti = utxo.getUtxosMulti;
    this.getHistoryMulti = utxo.getHistoryMulti;

    this.getLwsBalance = lws.getLwsBalance;
    this.getUnspentOuts = lws.getUnspentOuts;
    this.getRandomOuts = lws.getRandomOuts;
    this.submitLwsTx = lws.submitLwsTx;
    this.getLwsHistory = lws.getLwsHistory;
    this.registerLws = lws.registerLws;
    this.deactivateLws = lws.deactivateLws;
    this.provisionSubaddrs = lws.provisionSubaddrs;

    this.scanGrin = grin.scanGrin;
    this.getGrinAddressUser = grin.getGrinAddressUser;
    this.broadcastGrinTransaction = grin.broadcastGrinTransaction;
    this.createGrinRelay = grin.createGrinRelay;
    this.getGrinPendingSlatepacks = grin.getGrinPendingSlatepacks;
    this.signGrinSlatepack = grin.signGrinSlatepack;
    this.finalizeGrinSlatepack = grin.finalizeGrinSlatepack;
    this.cancelGrinSlatepack = grin.cancelGrinSlatepack;

    this.createSwap = swap.createSwap;
    this.getSwap = swap.getSwap;
    this.listSwaps = swap.listSwaps;
  }

  /** Current blockchain heights for all networks. */
  getBlockchainHeights(): Promise<
    ApiResponse<{
      btc: number | null;
      ltc: number | null;
      xmr: number | null;
      wow: number | null;
      grin: number | null;
    }>
  > {
    return this.request('/wallet/heights', { method: 'GET' });
  }

  /** Backend health check. */
  healthCheck(): Promise<ApiResponse<{ status: string }>> {
    return this.request('/health', { method: 'GET' });
  }

  /**
   * This backend instance's capabilities — enabled chains, features, and the
   * wallet-restore policy. The wallet reads this to adapt per-instance: grey out
   * disabled chains/features and shape the import-restore UX to the policy (see
   * `earliestRestoreDate`).
   */
  getCapabilities(): Promise<ApiResponse<BackendCapabilities>> {
    return this.request('/capabilities', { method: 'GET' });
  }

  /**
   * The authenticated user's premium subscription status. Requires a bearer
   * token. `active` gates premium-only actions — e.g. whether the Feed compose
   * box may post to a `premium-post` relay. Answers even on non-premium backends
   * (returns `{ active: false }`).
   */
  getPremiumStatus(): Promise<ApiResponse<PremiumStatus>> {
    return this.request('/premium/status', { method: 'GET' });
  }

  /** Current cryptocurrency prices. */
  getPrices(): Promise<
    ApiResponse<{
      btc: number | null;
      ltc: number | null;
      xmr: number | null;
      wow: number | null;
      grin: number | null;
      updated_at: string;
    }>
  > {
    return this.request('/prices', { method: 'GET' });
  }

  /** Sparkline (2-week downsampled price history) for an asset. */
  getSparkline(
    asset: string,
  ): Promise<
    ApiResponse<{ prices: number[]; min: number; max: number; change_pct: number }>
  > {
    // Namespaced smirk-backend-core has no /prices/sparkline route (it serves
    // /prices only), so hitting it is a guaranteed 404. Degrade gracefully to an
    // empty series: the asset-detail caller treats an empty `prices` as "no
    // sparkline" and simply omits the strip (it renders only when prices.length > 1).
    if (this.getWalletApiStyle() === 'namespaced') {
      return Promise.resolve({ data: { prices: [], min: 0, max: 0, change_pct: 0 } });
    }
    return this.request(`/prices/sparkline/${asset}`, { method: 'GET' });
  }

  /**
   * Migrate user keys to a new derivation scheme on the backend.
   * Updates user_keys + wallets tables to match the new pubkeys derived
   * client-side after a derivation-version bump.
   */
  migrateKeys(
    keys: Array<{
      asset: string;
      public_key: string;
      public_spend_key?: string;
      address?: string;
      view_key?: string;
    }>,
  ): Promise<ApiResponse<{ migrated: boolean }>> {
    return this.request('/auth/migrate-keys', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
  }
}

/** Default API instance pointing at production. */
export const api = new SmirkApi();

/**
 * Configure the shared `api` singleton at shell startup, before the first
 * request. Pass `baseUrl` (e.g. from `VITE_SMIRK_BACKEND_URL`) to target a
 * non-production backend: staging, local, or a self-hosted one. No-op when
 * `baseUrl` is empty, so default production builds are unaffected.
 *
 * This is the seam the ChainProvider work builds on: today it swaps the backend
 * URL; later it selects per-chain data sources (a bundled backend vs direct
 * electrum / lws / grin-lws).
 */
export function initSmirkApi(config: {
  baseUrl?: string | undefined;
  /**
   * Wallet route dialect: `flat` (legacy `/wallet/balance`) or `namespaced`
   * (`/wallet/utxo/*`, smirk-backend-core). Defaults to the client default
   * (`flat`) when omitted; a v0.3 shell targeting a v0.3 backend passes
   * `namespaced` (e.g. from `VITE_SMIRK_API_STYLE`).
   */
  walletApiStyle?: 'flat' | 'namespaced' | undefined;
}): void {
  if (config.baseUrl) api.setBaseUrl(config.baseUrl);
  if (config.walletApiStyle) api.setWalletApiStyle(config.walletApiStyle);
}
