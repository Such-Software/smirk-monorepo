/**
 * A swap's status is asked only of the backend that recorded the trade.
 *
 * Review of #46: the in-flight swap lives in the wallet's wizard store, which
 * survives a backend switch, and its status poll asked whichever backend the
 * window pointed at. A trade recorded while on one operator was looked up at
 * the next one, with that one's session, disclosing the trade to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SwapInFlight } from '@smirk/ui';

import { fetchTrocadorSwapStatus, type SwapStatusDeps } from '../swap-status';

const A = 'http://127.0.0.1:18701/api/v1';
const B = 'http://127.0.0.1:18702/api/v1';
const TRADE = 'trade-fixture';

function deps(current: string) {
  const asked: string[] = [];
  const d: SwapStatusDeps = {
    api: {
      getBaseUrl: () => current,
      getSwap: (async (id: string) => {
        asked.push(`${current}#${id}`);
        return {
          status: 200,
          data: {
            trade_id: id,
            from_asset: 'ltc',
            to_asset: 'xmr',
            amount_from_atomic: '100',
            amount_to_atomic: '5',
            deposit_address: 'deposit-fixture',
            status: 'finished',
          },
        };
      }) as unknown as SwapStatusDeps['api']['getSwap'],
    },
    trocador: {
      status: async (): Promise<SwapInFlight['state']> => ({ state: 'pending', reason: 'in_progress' }),
    },
  };
  return { d, asked };
}

test('a trade recorded at another backend is not looked up at this one', async () => {
  const { d, asked } = deps(A);
  const status = await fetchTrocadorSwapStatus(d, TRADE, B);
  assert.deepEqual(asked, [], 'the trade was disclosed to a backend that never recorded it');
  assert.equal(status.state.state, 'pending', 'the provider is still asked directly');
});

test('a trade with no recorded backend is not looked up at all', async () => {
  const { d, asked } = deps(A);
  await fetchTrocadorSwapStatus(d, TRADE, undefined);
  assert.deepEqual(asked, []);
});

test('the backend that recorded the trade is still consulted', async () => {
  const { d, asked } = deps(B);
  const status = await fetchTrocadorSwapStatus(d, TRADE, B);
  assert.deepEqual(asked, [`${B}#${TRADE}`]);
  assert.equal(status.state.state, 'completed');
  assert.equal(status.depositAddress, 'deposit-fixture');
});
