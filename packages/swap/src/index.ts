/**
 * `@smirk/swap`: swap orchestration layer.
 *
 * The wallet UI talks to a `Swap`. This package owns the interface and
 * the aggregator-style implementations. `TrocadorSwap` is the one that
 * ships in v0.3 and backs the swap screen; `ThorchainSwap` is a stub
 * whose methods throw `not_implemented`. Native peer-to-peer
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

export { ThorchainSwap, type ThorchainSwapOptions } from './thorchain';
export { TrocadorSwap, type TrocadorSwapOptions } from './trocador';
