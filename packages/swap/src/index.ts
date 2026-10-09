/**
 * `@smirk/swap`: swap orchestration layer.
 *
 * The wallet UI talks to a `Swap`. This package owns the interface and
 * the aggregator-style implementations. `TrocadorSwap` is the one that
 * ships in v0.3; `ThorchainSwap` routes BTC, LTC and (once THORChain
 * lists it) XMR through THORChain vault deposits. Native peer-to-peer
 * adaptor-signature implementations land in v0.4+ and will delegate the
 * cryptography to the `swap-core` Rust crate via `@smirk/wasm`.
 *
 * @example
 * ```ts
 * import { TrocadorSwap } from '@smirk/swap';
 *
 * // The constructor requires `apiKey`; `start` requires `refundAddress`.
 * const swap = new TrocadorSwap({ apiKey });
 * if (swap.supports('btc', 'ltc')) {
 *   const quote = await swap.quote({
 *     fromAsset: 'btc',
 *     toAsset: 'ltc',
 *     fromAmount: '100000',           // 0.001 BTC in atomic units
 *     toAddress: 'ltc1q...',
 *   });
 *   const started = await swap.start({
 *     quote,
 *     toAddress: 'ltc1q...',
 *     refundAddress: 'bc1q...',
 *   });
 *   // ... wallet sends to started.depositAddress, polls swap.status(started.id)
 * }
 * ```
 */

export type {
  AtomicAmount,
  QuoteRequest,
  Swap,
  SwapError,
  SwapId,
  SwapKind,
  SwapQuote,
  SwapStartParams,
  SwapStarted,
  SwapStatus,
} from './types';

export {
  ThorchainSwap,
  DEFAULT_THORCHAIN_POLICY,
  DEFAULT_ASSET_POLICY,
  DEFAULT_THORNODE_URL,
  assertMemo,
  toThorUnits,
  fromThorUnits,
  type ThorchainSwapOptions,
  type ThorchainAsset,
  type ThorchainAssetPolicy,
  type ThorchainPolicy,
  type ThorchainAvailability,
  type AssetAvailability,
  type ThorchainQuoteData,
} from './thorchain';
export { TrocadorSwap, type TrocadorSwapOptions } from './trocador';
export {
  NonlogsSwap,
  NonlogsBackendError,
  NONLOGS_MARKETS,
  NONLOGS_TAKER_FEE,
  NONLOGS_CONVENIENCE_FEE,
  mapStatus as mapNonlogsStatus,
  type NonlogsAsset,
  type NonlogsBackend,
  type NonlogsQuoteData,
  type NonlogsStarted,
  type NonlogsSwapOptions,
  type BookAnalysis,
} from './nonlogs';
export {
  walkLeg,
  walkRoute,
  planRoute,
  legsFromPairs,
  maxFillableInput,
  depthWarning,
  materiallyDifferent,
  IMPACT_NOTICE,
  IMPACT_STRONG,
  type OrderBook,
  type Leg,
  type LegResult,
  type RouteResult,
  type Fees,
  type DepthWarning,
} from './orderbook';
