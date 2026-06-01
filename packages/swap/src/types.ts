/**
 * Common swap-orchestration types.
 *
 * The wallet UI talks to a `Swap` regardless of whether the underlying
 * mechanism is an aggregator (THORChain in v0.3) or a peer-to-peer
 * adaptor-signature flow (v0.4+ for Grin↔BTC/LTC, v0.6+ for WOW↔XMR).
 *
 * Implementations live in sibling modules (`./thorchain`, eventually
 * `./native`). Consumers should import the `Swap` interface and the
 * common value types from this barrel.
 */

import type { AssetId } from '@smirk/assets';

/** Atomic-unit amount as a decimal string (avoid JS number precision loss). */
export type AtomicAmount = string;

/** Opaque identifier for a swap in progress. Format is implementation-defined. */
export type SwapId = string;

/** What backend is fulfilling this swap. UI can use this for routing labels. */
export type SwapKind = 'aggregator' | 'native';

export interface QuoteRequest {
  fromAsset: AssetId;
  toAsset: AssetId;
  /** Amount of `fromAsset` the user intends to send, in atomic units. */
  fromAmount: AtomicAmount;
  /**
   * Destination address. Required at `start()` time by every
   * implementation, but optional at `quote()` — aggregator-style
   * (CEX) swaps don't need it until the trade is finalized. Native
   * adaptor-signature implementations may inspect it earlier to
   * pre-validate or short-circuit invalid recipients.
   */
  toAddress?: string;
}

export interface SwapQuote {
  fromAsset: AssetId;
  toAsset: AssetId;
  fromAmount: AtomicAmount;
  /** Estimated output before slippage, in `toAsset` atomic units. */
  toAmountEstimate: AtomicAmount;
  /** Estimated network + protocol fees, in `fromAsset` atomic units. */
  feeEstimate: AtomicAmount;
  /** ETA from "user signs" to "output arrives", in seconds. */
  etaSeconds: number;
  /** When this quote stops being honored. UI should re-quote after. */
  expiresAt: Date;
  /** Aggregator vs native — informational, for UI. */
  kind: SwapKind;
  /** Implementation-specific. Pass back into `start()` unmodified. */
  implementationData: unknown;
}

export type SwapStatus =
  | { state: 'pending'; reason: 'awaiting_deposit' | 'awaiting_confirmations' | 'in_progress' }
  | { state: 'completed'; outboundTxId: string; toAmount: AtomicAmount }
  | { state: 'refunded'; refundTxId: string; reason: string }
  | { state: 'failed'; reason: string };

export interface SwapStarted {
  id: SwapId;
  /** The tx the wallet should broadcast or already broadcast to begin the swap. */
  depositTxId: string;
}

export interface SwapError extends Error {
  code:
    | 'quote_expired'
    | 'insufficient_amount'
    | 'asset_pair_unsupported'
    | 'network_error'
    | 'not_implemented';
}

/**
 * Common interface implemented by every swap backend.
 *
 * Lifecycle: `quote()` → user reviews → `start()` → poll `status()` until
 * terminal. All methods are async and may throw `SwapError`.
 */
export interface Swap {
  readonly kind: SwapKind;

  /** True if this implementation can swap `from` → `to`. */
  supports(from: AssetId, to: AssetId): boolean;

  /** Get a quote. Quotes have an expiry; re-call if stale. */
  quote(req: QuoteRequest): Promise<SwapQuote>;

  /** Begin the swap. May produce a tx the wallet then broadcasts. */
  start(quote: SwapQuote): Promise<SwapStarted>;

  /** Poll status. Safe to call repeatedly; UI decides cadence. */
  status(id: SwapId): Promise<SwapStatus>;
}
