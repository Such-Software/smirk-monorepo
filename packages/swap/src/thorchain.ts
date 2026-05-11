/**
 * THORChain aggregator-style swap implementation.
 *
 * Stub for v0.3 — defines the shape; concrete HTTP wiring against the
 * Midgard / Thornode APIs lands when the swap UI screen needs it.
 *
 * Reference docs:
 * - Quote endpoint: https://thornode.thorchain.info/thorchain/doc/
 * - Pool / pricing: https://midgard.ninerealms.com/v2/doc
 *
 * Supported pairs at the time of writing (subject to availability):
 *   BTC ↔ LTC ↔ ETH (USDC) ↔ BCH — XMR pending; WOW/Grin not on THORChain.
 */

import type { AssetId } from '@smirk/assets';
import type {
  QuoteRequest,
  Swap,
  SwapError,
  SwapId,
  SwapKind,
  SwapQuote,
  SwapStarted,
  SwapStatus,
} from './types';

export interface ThorchainSwapOptions {
  /** Override the Thornode base URL. Defaults to the public endpoint. */
  thornodeUrl?: string;
  /** Override the Midgard base URL. Defaults to the public endpoint. */
  midgardUrl?: string;
  /**
   * `fetch` impl. Defaults to `globalThis.fetch`. Injectable for tests
   * and for environments without a global fetch.
   */
  fetch?: typeof fetch;
}

export class ThorchainSwap implements Swap {
  readonly kind: SwapKind = 'aggregator';

  /** Asset IDs THORChain currently has live pools for, lowercased. */
  private static readonly SUPPORTED: ReadonlySet<AssetId> = new Set([
    'btc',
    'ltc',
    // xmr — once THORChain XMR rollout completes
  ]);

  constructor(private readonly opts: ThorchainSwapOptions = {}) {
    void this.opts;
  }

  supports(from: AssetId, to: AssetId): boolean {
    return (
      from !== to &&
      ThorchainSwap.SUPPORTED.has(from) &&
      ThorchainSwap.SUPPORTED.has(to)
    );
  }

  async quote(_req: QuoteRequest): Promise<SwapQuote> {
    throw notImplemented('ThorchainSwap.quote');
  }

  async start(_quote: SwapQuote): Promise<SwapStarted> {
    throw notImplemented('ThorchainSwap.start');
  }

  async status(_id: SwapId): Promise<SwapStatus> {
    throw notImplemented('ThorchainSwap.status');
  }
}

function notImplemented(method: string): SwapError {
  const err = new Error(`${method} is not implemented yet`) as SwapError;
  err.code = 'not_implemented';
  return err;
}
