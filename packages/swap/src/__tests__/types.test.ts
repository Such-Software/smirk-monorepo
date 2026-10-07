import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ThorchainSwap } from '../index';
import type { Swap, SwapError } from '../index';

describe('ThorchainSwap', () => {
  it('reports kind as aggregator', () => {
    const swap: Swap = new ThorchainSwap();
    assert.equal(swap.kind, 'aggregator');
  });

  it('supports BTC ↔ LTC and rejects same-asset / unsupported pairs', () => {
    const swap = new ThorchainSwap();
    assert.equal(swap.supports('btc', 'ltc'), true);
    assert.equal(swap.supports('ltc', 'btc'), true);
    assert.equal(swap.supports('btc', 'btc'), false);
    // grin and wow are not THORChain pools; must fall through to native
    // (ThorchainSwap returns false; the swap router then tries NativeSwap).
    assert.equal(swap.supports('grin', 'btc'), false);
    assert.equal(swap.supports('wow', 'xmr'), false);
  });

  it('supports XMR pairs statically; whether they are live is decided at runtime', () => {
    const swap = new ThorchainSwap();
    assert.equal(swap.supports('xmr', 'btc'), true);
    assert.equal(swap.supports('btc', 'xmr'), true);
  });

  it('start refuses a quote that is not a THORChain quote, without touching the network', async () => {
    let called = false;
    const swap = new ThorchainSwap({
      fetch: (async () => {
        called = true;
        throw new Error('no network in this test');
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      swap.start({
        quote: {
          fromAsset: 'btc',
          toAsset: 'ltc',
          fromAmount: '100000',
          toAmountEstimate: '0',
          feeEstimate: '0',
          etaSeconds: 0,
          expiresAt: new Date(),
          kind: 'aggregator',
          implementationData: null,
        },
      }),
      (err: unknown) => (err as SwapError).code === 'network_error',
    );
    assert.equal(called, false);
  });
});
