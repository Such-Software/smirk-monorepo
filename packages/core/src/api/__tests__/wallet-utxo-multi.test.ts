/**
 * Multi-address BTC/LTC calls: batching, merging, and graceful degradation.
 *
 * What is locked in here:
 *  - The client never sends more than `UTXO_MULTI_MAX_ADDRESSES` addresses in
 *    one request. The backend rejects an oversized batch with a 400 rather than
 *    truncating it, and the scan set passes that cap after a handful of
 *    change-producing sends, so an unbatched client would make BTC/LTC
 *    permanently unreadable and unspendable in-app.
 *  - Merging is exact: balances sum, UTXOs and history concatenate, and every
 *    returned UTXO keeps the CLIENT-side master path (money gate G9).
 *  - A 404 (backend feature off, or a legacy dialect that never had the route)
 *    degrades to the per-address routes instead of reading zero.
 *  - Any other failure fails the whole call rather than returning a partial
 *    sum, which would silently under-report the balance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ApiClient, ApiResponse } from '../client';
import {
  createWalletUtxoMethods,
  UTXO_MULTI_MAX_ADDRESSES,
  type UtxoAddressRef,
} from '../wallet-utxo';

interface RequestLog {
  path: string;
  body: Record<string, unknown>;
}

type Responder = (path: string, body: Record<string, unknown>) => ApiResponse<unknown>;

/** A duck-typed ApiClient that records every request and answers via `respond`. */
function mockClient(respond: Responder): { client: ApiClient; log: RequestLog[] } {
  const log: RequestLog[] = [];
  const client = {
    getWalletApiStyle: () => 'namespaced' as const,
    request: (path: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      log.push({ path, body });
      return Promise.resolve(respond(path, body));
    },
  } as unknown as ApiClient;
  return { client, log };
}

const addrs = (n: number): string[] => Array.from({ length: n }, (_, i) => `bc1qaddr${i}`);
const refs = (n: number): UtxoAddressRef[] =>
  Array.from({ length: n }, (_, i) => ({
    address: `bc1qaddr${i}`,
    masterPath: `m/84'/0'/0'/0/${i}`,
  }));

// ---- batching ---------------------------------------------------------------

test('balance_multi splits an oversized address list into capped batches and sums them', async () => {
  const { client, log } = mockClient((_p, body) => ({
    data: {
      asset: 'btc',
      confirmed: (body.addresses as string[]).length * 100,
      unconfirmed: 0,
    },
    status: 200,
  }));
  const api = createWalletUtxoMethods(client);

  // 70 addresses is the realistic scan set once both gap windows are open.
  const r = await api.getUtxoBalanceMulti('btc', addrs(70));

  assert.equal(log.length, 3, '70 addresses -> ceil(70/32) = 3 requests');
  for (const entry of log) {
    assert.ok(
      (entry.body.addresses as string[]).length <= UTXO_MULTI_MAX_ADDRESSES,
      'no batch exceeds the server cap',
    );
  }
  // Every address is asked about exactly once.
  const asked = log.flatMap((e) => e.body.addresses as string[]);
  assert.equal(asked.length, 70);
  assert.equal(new Set(asked).size, 70);
  assert.equal(r.data?.confirmed, 7000, 'the sum covers the whole address set');
  assert.equal(r.data?.total, 7000, 'total is computed, not left undefined');
});

test('utxos_multi batches and keeps every UTXO, tagged with the client-side path', async () => {
  const { client, log } = mockClient((_p, body) => ({
    data: {
      asset: 'btc',
      utxos: (body.addresses as string[]).map((address, i) => ({
        address,
        txid: `${address}-tx`,
        vout: i,
        value: 1000,
        height: 900_000,
      })),
    },
    status: 200,
  }));
  const api = createWalletUtxoMethods(client);

  const r = await api.getUtxosMulti('btc', refs(70));

  assert.equal(log.length, 3);
  assert.equal(r.data?.utxos.length, 70, 'no UTXO is lost across the batch boundary');
  // Paths come from the caller's refs, never from the wire (money gate G9).
  const byAddress = new Map(r.data!.utxos.map((u) => [u.address, u.masterPath]));
  assert.equal(byAddress.get('bc1qaddr0'), "m/84'/0'/0'/0/0");
  assert.equal(byAddress.get('bc1qaddr69'), "m/84'/0'/0'/0/69");
});

test('history_multi batches and concatenates', async () => {
  const { client, log } = mockClient((_p, body) => ({
    data: {
      asset: 'btc',
      transactions: (body.addresses as string[]).map((a) => ({ txid: `${a}-tx`, height: 1 })),
    },
    status: 200,
  }));
  const api = createWalletUtxoMethods(client);
  const r = await api.getHistoryMulti('btc', addrs(40));
  assert.equal(log.length, 2);
  assert.equal(r.data?.transactions.length, 40);
});

test('a batch exactly at the cap is one request; one past it is two', async () => {
  const ok = () => ({ data: { asset: 'btc', confirmed: 0, unconfirmed: 0 }, status: 200 });
  const atCap = mockClient(ok);
  await createWalletUtxoMethods(atCap.client).getUtxoBalanceMulti(
    'btc',
    addrs(UTXO_MULTI_MAX_ADDRESSES),
  );
  assert.equal(atCap.log.length, 1);

  const overCap = mockClient(ok);
  await createWalletUtxoMethods(overCap.client).getUtxoBalanceMulti(
    'btc',
    addrs(UTXO_MULTI_MAX_ADDRESSES + 1),
  );
  assert.equal(overCap.log.length, 2);
});

// ---- de-duplication ---------------------------------------------------------

test('a duplicated address is queried (and counted) once', async () => {
  const { client, log } = mockClient((_p, body) => ({
    data: { asset: 'btc', confirmed: (body.addresses as string[]).length * 500, unconfirmed: 0 },
    status: 200,
  }));
  const r = await createWalletUtxoMethods(client).getUtxoBalanceMulti('btc', [
    'bc1qaddr0',
    'bc1qaddr0',
    'bc1qaddr1',
  ]);
  assert.deepEqual(log[0]!.body.addresses, ['bc1qaddr0', 'bc1qaddr1']);
  assert.equal(r.data?.confirmed, 1000, 'the duplicate is not double-counted');
});

test('an empty address list short-circuits with a zero result and no request', async () => {
  const { client, log } = mockClient(() => ({ data: {}, status: 200 }));
  const api = createWalletUtxoMethods(client);
  assert.equal((await api.getUtxoBalanceMulti('btc', [])).data?.confirmed, 0);
  assert.deepEqual((await api.getUtxosMulti('btc', [])).data?.utxos, []);
  assert.deepEqual((await api.getHistoryMulti('btc', [])).data?.transactions, []);
  assert.equal(log.length, 0);
});

// ---- 404 degradation --------------------------------------------------------

test('balance_multi falls back to the per-address route on 404 and still sums correctly', async () => {
  const { client, log } = mockClient((path) => {
    if (path.endsWith('_multi')) return { error: 'not found', status: 404 };
    return { data: { asset: 'btc', address: 'a', confirmed: 7, unconfirmed: 1 }, status: 200 };
  });
  const r = await createWalletUtxoMethods(client).getUtxoBalanceMulti('btc', addrs(5));
  assert.equal(r.error, undefined, 'a backend without the feature is not an error');
  assert.equal(r.data?.confirmed, 35);
  assert.equal(r.data?.unconfirmed, 5);
  assert.equal(
    log.filter((e) => e.path === '/wallet/utxo/balance').length,
    5,
    'one per-address request per address',
  );
});

test('utxos_multi falls back on 404 and tags each UTXO from the ref it asked with', async () => {
  const { client } = mockClient((path, body) => {
    if (path.endsWith('_multi')) return { error: 'not found', status: 404 };
    return {
      data: {
        asset: 'btc',
        address: body.address as string,
        utxos: [{ txid: `${body.address as string}-tx`, vout: 0, value: 42, height: 1 }],
      },
      status: 200,
    };
  });
  const r = await createWalletUtxoMethods(client).getUtxosMulti('btc', refs(3));
  assert.equal(r.data?.utxos.length, 3);
  assert.deepEqual(
    r.data!.utxos.map((u) => u.masterPath),
    ["m/84'/0'/0'/0/0", "m/84'/0'/0'/0/1", "m/84'/0'/0'/0/2"],
  );
  assert.equal(r.data!.utxos[0]!.address, 'bc1qaddr0');
});

test('history_multi falls back on 404', async () => {
  const { client } = mockClient((path, body) => {
    if (path.endsWith('_multi')) return { error: 'not found', status: 404 };
    return {
      data: { asset: 'btc', address: body.address, transactions: [{ txid: 't', height: 1 }] },
      status: 200,
    };
  });
  const r = await createWalletUtxoMethods(client).getHistoryMulti('btc', addrs(4));
  assert.equal(r.data?.transactions.length, 4);
});

// ---- failure is never partial ----------------------------------------------

test('a failing batch fails the whole call rather than under-reporting', async () => {
  let seen = 0;
  const { client } = mockClient((_p, body) => {
    seen++;
    if (seen === 2) return { error: 'upstream node unavailable', status: 503 };
    return {
      data: { asset: 'btc', confirmed: (body.addresses as string[]).length, unconfirmed: 0 },
      status: 200,
    };
  });
  const r = await createWalletUtxoMethods(client).getUtxoBalanceMulti('btc', addrs(70));
  assert.equal(r.data, undefined, 'no partial sum is handed back');
  assert.equal(r.status, 503);
  assert.match(r.error!, /unavailable/);
});

test('a failing per-address fallback request fails the whole call too', async () => {
  let seen = 0;
  const { client } = mockClient((path) => {
    if (path.endsWith('_multi')) return { error: 'not found', status: 404 };
    seen++;
    return seen === 3
      ? { error: 'timeout', status: 504 }
      : { data: { asset: 'btc', address: 'a', confirmed: 1, unconfirmed: 0 }, status: 200 };
  });
  const r = await createWalletUtxoMethods(client).getUtxoBalanceMulti('btc', addrs(5));
  assert.equal(r.data, undefined);
  assert.equal(r.status, 504);
});

// ---- the single-address path is untouched ----------------------------------

test('the single-address methods still make exactly one plain request', async () => {
  const { client, log } = mockClient(() => ({
    data: { asset: 'btc', address: 'a', confirmed: 1, unconfirmed: 0 },
    status: 200,
  }));
  const api = createWalletUtxoMethods(client);
  await api.getUtxoBalance('btc', 'bc1qaddr0');
  assert.equal(log.length, 1);
  assert.equal(log[0]!.path, '/wallet/utxo/balance');
  assert.deepEqual(log[0]!.body, { asset: 'btc', address: 'bc1qaddr0' });
});
