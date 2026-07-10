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
   * Destination address. Optional at `quote()` time — CEX aggregators
   * don't need it until `start()`. Native adaptor-signature swaps may
   * inspect it earlier to pre-validate. Always supplied later via
   * `SwapStartParams.toAddress` regardless.
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

/**
 * Params for `Swap.start()`. Field set is the union across swap
 * families; each implementation enforces what it actually requires:
 *
 *   - CEX aggregator (Trocador): `toAddress` + `refundAddress` required.
 *   - DEX (THORChain): `toAddress` required; refund derives from the
 *     deposit chain automatically.
 *   - Onramp (hosted-UI fiat): nothing extra; the provider's hosted UI
 *     collects the destination during KYC.
 *   - Native atomic (Grin↔BTC, WOW↔XMR): `counterpartyData` required;
 *     the multi-round protocol replaces address routing.
 *
 * One shape per swap family was rejected as premature — discriminated
 * unions add type churn before we know which fields land where. Each
 * impl validates its own slice and throws a clear `SwapError` for
 * missing input.
 */
export interface SwapStartParams {
  quote: SwapQuote;
  /** Where the `toAsset` output lands. Required by CEX/DEX. */
  toAddress?: string;
  /** Where `fromAsset` returns to if the swap fails. Required by CEX
   *  (provider needs a return address); DEX derives it from the
   *  deposit chain; native atomic uses a refund timelock. */
  refundAddress?: string;
  /**
   * Per-trade correlation token the provider echoes back on webhook
   * deliveries to authenticate them. Aggregators (Trocador) pass this
   * verbatim as their `passthrough` query param and POST it on every
   * status webhook; the wallet's backend matches it against the
   * `webhook_token` it persisted on `createSwap`. Without per-trade
   * tokens, webhook auth degrades to "any caller knowing the
   * trade_id can move the status" — the constant-time comparison on
   * the backend stops mattering. Constructor-time `opts.passthrough`
   * is preserved for back-compat, but a per-trade token passed here
   * takes precedence (see `TrocadorSwap.start`).
   */
  passthrough?: string;
  /** Counterparty exchange data for native atomic swaps (slate,
   *  adaptor commitment, etc.). Untyped here; each native impl
   *  narrows it. */
  counterpartyData?: unknown;
}

export interface SwapStarted {
  id: SwapId;
  /**
   * Where the wallet sends `fromAmount` to begin the swap.
   *
   * - **CEX/DEX:** an on-chain address Trocador/THORChain/etc. returns.
   *   The wallet routes this through SendWizard.
   * - **Native atomic:** the wallet's *own* derived multisig address
   *   built from the adaptor-sig setup. Wallet still sends to it,
   *   but the protocol decides the path out.
   *
   * Despite the name being a chain-level term, this is **not** a
   * broadcast txid — the wallet hasn't broadcast anything yet at
   * start() return. Status polls reveal the eventual deposit txid
   * via `SwapStatus.outboundTxId` once the chain catches up.
   */
  depositAddress: string;
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

  /**
   * Begin the swap. Returns the address the wallet sends to, plus an
   * id the caller polls via `status()`. May produce a tx the wallet
   * then broadcasts depending on the swap family.
   *
   * Implementations validate `params` themselves and throw a
   * `SwapError` with code `not_implemented` (or `network_error`) when
   * required fields are missing.
   */
  start(params: SwapStartParams): Promise<SwapStarted>;

  /** Poll status. Safe to call repeatedly; UI decides cadence. */
  status(id: SwapId): Promise<SwapStatus>;
}
