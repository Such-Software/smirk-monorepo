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

  it('quote/start/status throw `not_implemented` until v0.3 wires HTTP', async () => {
    const swap = new ThorchainSwap();
    for (const fn of [
      () =>
        swap.quote({
          fromAsset: 'btc',
          toAsset: 'ltc',
          fromAmount: '100000',
          toAddress: 'ltc1q',
        }),
      () =>
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
      () => swap.status('any-id'),
    ]) {
      await assert.rejects(fn, (err: unknown) => {
        const e = err as SwapError;
        return e.code === 'not_implemented';
      });
    }
  });
});
