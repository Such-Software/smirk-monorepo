import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ThorchainSwap, assertMemo, toThorUnits, fromThorUnits, type ThorchainPolicy } from '../thorchain';
import type { SwapError } from '../types';

// Recorded from THORChain mainnet on 2026-10-07 (BTC, LTC) and synthesized in
// the same shape for XMR, which THORChain had not listed yet. See each file's
// _meta.
const MAIN = JSON.parse(readFileSync(new URL('./fixtures/thorchain/mainnet-btc-ltc.json', import.meta.url), 'utf8'));
const STATUS = JSON.parse(readFileSync(new URL('./fixtures/thorchain/mainnet-tx-status.json', import.meta.url), 'utf8'));
const XMR = JSON.parse(readFileSync(new URL('./fixtures/thorchain/xmr-synthesized.json', import.meta.url), 'utf8'));

const LTC_DEST: string = MAIN._meta.ltc_destination;
const BTC_DEST: string = MAIN._meta.btc_destination;
const XMR_REFUND: string = XMR._meta.xmr_refund;
// Just before the recorded quotes' expiry.
const NOW = 1791385044_000 - 5 * 60_000;

interface World {
  pools: unknown[];
  inbound: Array<Record<string, unknown>>;
  quotes: Record<string, unknown>;
  statuses: Record<string, unknown>;
}

function world(withXmr = false): World {
  return {
    pools: withXmr ? [...MAIN.pools, XMR.pool_xmr] : [...MAIN.pools],
    inbound: withXmr ? [...MAIN.inbound_addresses, XMR.inbound_xmr] : MAIN.inbound_addresses.map((x: object) => ({ ...x })),
    quotes: {},
    statuses: {},
  };
}

function harness(w: World, opts: { policy?: ThorchainPolicy; affiliate?: { name: string; bps: number } } = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let clock = NOW;
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/thorchain/pools')) return reply(200, w.pools);
    if (u.pathname.endsWith('/thorchain/inbound_addresses')) return reply(200, w.inbound);
    if (u.pathname.endsWith('/thorchain/quote/swap')) {
      const key = `${u.searchParams.get('from_asset')}>${u.searchParams.get('to_asset')}`;
      const q = w.quotes[key];
      if (!q) return reply(400, { code: 3, message: 'no fixture for ' + key });
      const { _http, body } = q as { _http?: number; body?: unknown };
      return _http ? reply(_http, body) : reply(200, q);
    }
    const m = /\/thorchain\/tx\/status\/([0-9A-F]+)$/.exec(u.pathname);
    if (m) return reply(200, w.statuses[m[1]!] ?? MAIN.tx_status_unknown);
    return reply(404, { message: 'unexpected ' + u.pathname });
  }) as unknown as typeof fetch;
  const swap = new ThorchainSwap({
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...(opts.policy ? { policy: () => opts.policy! } : {}),
    ...(opts.affiliate ? { affiliate: opts.affiliate } : {}),
  });
  return { swap, calls, sleeps, advance: (ms: number) => (clock += ms) };
}

async function rejects(p: Promise<unknown>, code: SwapError['code']) {
  await assert.rejects(p, (e: SwapError) => {
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test('BTC and LTC are offered while THORChain reports them live; XMR is not listed yet', async () => {
  // Opened by the operator, so the reason is THORChain's own listing state.
  const { swap } = harness(world(), { policy: { enabled: true, assets: { xmr: 'auto' } } });
  const a = await swap.availability();
  assert.equal(a.btc.available, true);
  assert.equal(a.ltc.available, true);
  assert.equal(a.xmr.available, false);
  assert.match(a.xmr.reason!, /not listed/);
  assert.deepEqual(await swap.availablePairs(), [{ from: 'btc', to: 'ltc' }, { from: 'ltc', to: 'btc' }]);
});

/** The only policy that opens XMR: the operator naming it. */
const XMR_ON: ThorchainPolicy = { enabled: true, assets: { xmr: 'auto' } };

test('XMR stays closed when THORChain lists it, unless the wallet server opens it by name', async () => {
  // A listing alone, an absent policy (unreachable or older backend) and the
  // production shape today ({enabled:true} with no asset overrides) all leave
  // XMR off: its only evidence is a synthesized fixture.
  for (const policy of [undefined, { enabled: true }] as const) {
    const { swap } = harness(world(true), policy ? { policy } : {});
    const a = await swap.availability();
    assert.equal(a.xmr.available, false, JSON.stringify(policy));
    assert.match(a.xmr.reason!, /not yet enabled/);
    assert.equal(a.btc.available, true, 'BTC and LTC still follow THORChain');
    const pairs = await swap.availablePairs();
    assert.ok(!pairs.some((p) => p.from === 'xmr' || p.to === 'xmr'));
    await rejects(
      swap.quote({ fromAsset: 'xmr', toAsset: 'btc', fromAmount: '1000000000000', toAddress: BTC_DEST, refundAddress: XMR_REFUND }),
      'provider_unavailable',
    );
  }

  const { swap } = harness(world(true), { policy: XMR_ON });
  const a = await swap.availability();
  assert.equal(a.xmr.available, true);
  assert.equal(a.xmr.inboundAddress, XMR.inbound_xmr.address);
  const pairs = await swap.availablePairs();
  assert.ok(pairs.some((p) => p.from === 'xmr' && p.to === 'btc'));
  assert.ok(pairs.some((p) => p.from === 'xmr' && p.to === 'ltc'));
  // BTC/LTC cannot carry a Monero destination in 80 bytes.
  assert.ok(!pairs.some((p) => p.to === 'xmr'));
});

test('a provider the wallet server switched off asks THORChain nothing', async () => {
  for (const policy of [{ enabled: false }, { enabled: true, assets: { btc: 'off', ltc: 'off' } }] as ThorchainPolicy[]) {
    const { swap, calls } = harness(world(true), { policy });
    const a = await swap.availability(true);
    assert.ok(!a.btc.available && !a.ltc.available && !a.xmr.available);
    assert.deepEqual(await swap.availablePairs(), []);
    assert.deepEqual(calls, [], `no request for ${JSON.stringify(policy)}`);
  }
});

test('the wallet server can switch the provider or one asset off remotely', async () => {
  const off = harness(world(true), { policy: { enabled: false } });
  const a = await off.swap.availability();
  assert.ok(!a.btc.available && !a.ltc.available && !a.xmr.available);
  assert.match(a.btc.reason!, /turned off/);
  const xmrOff = harness(world(true), { policy: { enabled: true, assets: { xmr: 'off' } } });
  const b = await xmrOff.swap.availability();
  assert.equal(b.xmr.available, false);
  assert.match(b.xmr.reason!, /turned off/);
  assert.equal(b.btc.available, true);
});

test('a halted chain, paused trading or an unavailable pool closes that asset', async () => {
  for (const patch of [{ halted: true }, { chain_trading_paused: true }, { global_trading_paused: true }, { address: '' }]) {
    const w = world();
    w.inbound = w.inbound.map((x) => (x.chain === 'BTC' ? { ...x, ...patch } : x));
    const a = await harness(w).swap.availability();
    assert.equal(a.btc.available, false, JSON.stringify(patch));
    assert.equal(a.ltc.available, true);
  }
  const w = world();
  w.pools = (w.pools as Array<{ asset: string }>).map((p) => (p.asset === 'LTC.LTC' ? { ...p, status: 'Staged' } : p));
  const a = await harness(w).swap.availability();
  assert.equal(a.ltc.available, false);
  assert.match(a.ltc.reason!, /staged/);
});

test('a BTC to LTC quote carries a checked memo with a price limit', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = {
    ...MAIN.quote_btc_to_ltc,
    memo: `=:l:${LTC_DEST}:1212699958`,
    inbound_address: MAIN.inbound_addresses[0].address,
  };
  const { swap, calls } = harness(w);
  const q = await swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000', toAddress: LTC_DEST });
  const data = q.implementationData as { memo: string; inboundAddress: string; expiresAtMs: number };
  assert.equal(data.memo, `=:l:${LTC_DEST}:1212699958`);
  assert.equal(data.inboundAddress, MAIN.inbound_addresses[0].address);
  assert.equal(q.toAmountEstimate, MAIN.quote_btc_to_ltc.expected_amount_out);
  assert.ok(data.expiresAtMs <= NOW + 10 * 60_000, 'never longer than ten minutes');
  const quoteCall = calls.find((c) => c.includes('/quote/swap'))!;
  assert.match(quoteCall, /tolerance_bps=300/);
  assert.doesNotMatch(quoteCall, /refund_address/, 'a UTXO refund address would overflow 80 bytes');
});

test('the affiliate fee is added only when configured', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = {
    ...MAIN.quote_btc_to_ltc_affiliate,
    memo: `=:l:${LTC_DEST}:1212699958:smirk:50`,
    inbound_address: MAIN.inbound_addresses[0].address,
  };
  const { swap, calls } = harness(w, { affiliate: { name: 'smirk', bps: 50 } });
  await swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000', toAddress: LTC_DEST });
  assert.match(calls.find((c) => c.includes('/quote/swap'))!, /affiliate=smirk&affiliate_bps=50/);
});

test('THORChain refusing an oversized memo becomes a clear unsupported-pair error', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = MAIN.quote_btc_to_ltc_refund_memo_too_long;
  const { swap } = harness(w);
  await rejects(swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000', toAddress: LTC_DEST }), 'asset_pair_unsupported');
});

test('below THORChain\'s recommended minimum is refused before any deposit', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = {
    ...MAIN.quote_btc_to_ltc_too_small,
    memo: `=:l:${LTC_DEST}:1`,
    inbound_address: MAIN.inbound_addresses[0].address,
  };
  await rejects(harness(w).swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000', toAddress: LTC_DEST }), 'insufficient_amount');
});

test('a memo that names another address, asset or no limit is refused', () => {
  const base = { toAsset: 'ltc' as const, destination: LTC_DEST, maxBytes: 80 };
  assert.doesNotThrow(() => assertMemo(`=:l:${LTC_DEST}:1`, base));
  assert.throws(() => assertMemo(`=:l:ltc1qattackerattackerattackerattackerattacke:1`, base));
  assert.throws(() => assertMemo(`=:b:${LTC_DEST}:1`, base));
  assert.throws(() => assertMemo(`=:l:${LTC_DEST}`, base), /price limit/);
  assert.throws(() => assertMemo(`ADD:l:${LTC_DEST}:1`, base));
  assert.throws(() => assertMemo(`=:l:${LTC_DEST}:${'9'.repeat(40)}`, base), /bytes/);
});

test('a vault rotation between availability and quote is refused, not guessed', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = { ...MAIN.quote_btc_to_ltc, memo: `=:l:${LTC_DEST}:1`, inbound_address: 'bc1qsomeothervaultaddressxxxxxxxxxxxxxxxxx' };
  await rejects(harness(w).swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000', toAddress: LTC_DEST }), 'quote_expired');
});

test('XMR swaps require a refund address, and the memo must carry it', async () => {
  const w = world(true);
  w.quotes['XMR.XMR>BTC.BTC'] = XMR.quote_xmr_to_btc;
  const { swap, calls } = harness(w, { policy: XMR_ON });
  await rejects(swap.quote({ fromAsset: 'xmr', toAsset: 'btc', fromAmount: '1000000000000', toAddress: BTC_DEST }), 'refund_address_required');
  const q = await swap.quote({
    fromAsset: 'xmr', toAsset: 'btc', fromAmount: '1000000000000', toAddress: BTC_DEST, refundAddress: XMR_REFUND,
  });
  const data = q.implementationData as { memo: string; refundAddress: string; inboundAddress: string };
  assert.equal(data.refundAddress, XMR_REFUND);
  assert.ok(data.memo.includes(`/${XMR_REFUND}:`));
  assert.ok(new TextEncoder().encode(data.memo).length <= 254, 'fits Monero tx_extra arbitrary data');
  assert.equal(data.inboundAddress, XMR.inbound_xmr.address);
  // 1 XMR = 1e12 piconero = 1e8 THORChain units.
  assert.match(calls.find((c) => c.includes('/quote/swap'))!, /amount=100000000&/);
  assert.match(calls.find((c) => c.includes('/quote/swap'))!, /refund_address=44AFF/);

  const stripped = world(true);
  stripped.quotes['XMR.XMR>BTC.BTC'] = { ...XMR.quote_xmr_to_btc, memo: `=:b:${BTC_DEST}:286150` };
  await rejects(
    harness(stripped, { policy: XMR_ON }).swap.quote({ fromAsset: 'xmr', toAsset: 'btc', fromAmount: '1000000000000', toAddress: BTC_DEST, refundAddress: XMR_REFUND }),
    'network_error',
  );
});

test('BTC or LTC to XMR is refused with the reason, not attempted', async () => {
  const { swap } = harness(world(true), { policy: XMR_ON });
  await rejects(swap.quote({ fromAsset: 'btc', toAsset: 'xmr', fromAmount: '1000000', toAddress: XMR_REFUND }), 'asset_pair_unsupported');
});

test('start re-checks liveness and returns the vault address and memo', async () => {
  const w = world();
  w.quotes['BTC.BTC>LTC.LTC'] = { ...MAIN.quote_btc_to_ltc, memo: `=:l:${LTC_DEST}:1212699958`, inbound_address: MAIN.inbound_addresses[0].address };
  const { swap, advance } = harness(w);
  const quote = await swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000', toAddress: LTC_DEST });
  const started = await swap.start({ quote, toAddress: LTC_DEST });
  assert.equal(started.depositAddress, MAIN.inbound_addresses[0].address);
  assert.equal(started.memo, `=:l:${LTC_DEST}:1212699958`);
  assert.match(started.id, /^thorchain:[0-9a-f]{32}$/);

  // Halted after the quote: start refuses.
  w.inbound = w.inbound.map((x) => (x.chain === 'BTC' ? { ...x, halted: true } : x));
  await rejects(swap.start({ quote, toAddress: LTC_DEST }), 'provider_unavailable');
  // Expired: refused before asking anyone.
  w.inbound = MAIN.inbound_addresses;
  advance(11 * 60_000);
  await rejects(swap.start({ quote, toAddress: LTC_DEST }), 'quote_expired');
});

test('requests are spaced at least one second apart', async () => {
  const { swap, sleeps } = harness(world());
  await swap.availability(true);
  await swap.availability(true);
  assert.ok(sleeps.length >= 1);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 1000));
});

test('status maps recorded THORChain transactions', async () => {
  const w = world();
  const done = STATUS.tx_status_completed;
  const pending = STATUS.tx_status_pending;
  w.statuses[done.txid] = done.response;
  w.statuses[pending.txid] = pending.response;
  w.statuses[XMR.tx_status_refunded.tx.id] = XMR.tx_status_refunded;
  const { swap } = harness(w);

  const c = await swap.status(done.txid);
  assert.equal(c.state, 'completed');
  if (c.state === 'completed') {
    assert.equal(c.outboundTxId, '3EA00DF272DA8B5FB8ED58677C8237AE82B5AEA62BB85C030CE05DA3D02851BD');
    assert.equal(c.toAmount, '3949217');
  }
  assert.deepEqual(await swap.status(pending.txid), { state: 'pending', reason: 'in_progress' });
  const r = await swap.status(XMR.tx_status_refunded.tx.id);
  assert.equal(r.state, 'refunded');
  assert.deepEqual(await swap.status('00'.repeat(32)), { state: 'pending', reason: 'awaiting_deposit' });
  assert.deepEqual(await swap.status('thorchain:abc'), { state: 'pending', reason: 'awaiting_deposit' });
});

test('unit conversion between native atomic units and THORChain 1e8 units', () => {
  assert.equal(toThorUnits('1000000000000', 12), 100000000n);
  assert.equal(toThorUnits('12345', 12), 1n);
  assert.equal(fromThorUnits('100000000', 12), '1000000000000');
  assert.equal(toThorUnits('5000', 8), 5000n);
  assert.equal(fromThorUnits('5000', 8), '5000');
});
