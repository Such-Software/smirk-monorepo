/**
 * What a THORChain quote tells the user, and what Confirm will sign.
 *
 * THORChain takes its fees in the destination asset, out of the estimate. The
 * quote screen used to read "Network/provider fee ≈ 0 BTC", said nothing about
 * the 3 percent price limit written into the memo, and Confirm signed a second,
 * binding quote it never compared with the one on screen: an 8 percent worse
 * market went straight to a deposit.
 *
 * Runs the real ThorchainSwap against the recorded mainnet fixture.
 */
import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ThorchainSwap, type SwapError } from '@smirk/swap';

import {
  MAX_REQUOTE_DRIFT_BPS,
  confirmThorchainSwap,
  thorchainGatewayHost,
  thorchainQuoteSummary,
} from '../thorchain';

const MAIN = JSON.parse(
  readFileSync(new URL('../../../../swap/src/__tests__/fixtures/thorchain/mainnet-btc-ltc.json', import.meta.url), 'utf8'),
);
const LTC_DEST: string = MAIN._meta.ltc_destination;
// Just before the recorded quote's expiry.
const NOW = MAIN.quote_btc_to_ltc.expiry * 1000 - 5 * 60_000;
const SHOWN_OUT = BigInt(MAIN.quote_btc_to_ltc.expected_amount_out);

/** A ThorchainSwap whose market moves by `bps` (negative is worse) once the destination is known. */
function market(bindingDriftBps: number) {
  const calls: string[] = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith('/thorchain/pools')) return reply(MAIN.pools);
    if (u.pathname.endsWith('/thorchain/inbound_addresses')) return reply(MAIN.inbound_addresses);
    if (u.pathname.endsWith('/thorchain/quote/swap')) {
      const binding = u.searchParams.has('destination');
      const out = binding ? (SHOWN_OUT * BigInt(10_000 + bindingDriftBps)) / 10_000n : SHOWN_OUT;
      return reply({
        ...MAIN.quote_btc_to_ltc,
        inbound_address: MAIN.inbound_addresses[0].address,
        expected_amount_out: out.toString(),
        memo: `=:l:${LTC_DEST}:${((out * 97n) / 100n).toString()}`,
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  let clock = NOW;
  const swap = new ThorchainSwap({ fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; } });
  return { swap, calls };
}

async function indicative(swap: ThorchainSwap) {
  return thorchainQuoteSummary(await swap.quote({ fromAsset: 'btc', toAsset: 'ltc', fromAmount: '1000000' }));
}

test('the fee row carries THORChain\'s own fees, in the destination asset, as part of the estimate', async () => {
  const shown = await indicative(market(0).swap);
  assert.equal(shown.feeAssetId, 'ltc');
  assert.equal(shown.feeIncludedInEstimate, true);
  assert.equal(shown.feeEstimateAtomic, MAIN.quote_btc_to_ltc.fees.total);
  assert.notEqual(shown.feeEstimateAtomic, '0');
});

test('the notices state the price limit, the re-quote rule, the deadline and who sees the request', async () => {
  const shown = await indicative(market(0).swap);
  const text = (shown.notices ?? []).join('\n');
  const data = shown.providerData as { toleranceBps: number };
  assert.ok(text.includes(`${data.toleranceBps / 100}%`), 'states the price limit the memo carries');
  assert.match(text, /refund/i);
  assert.ok(text.includes(`${MAX_REQUOTE_DRIFT_BPS / 100}%`), 'states the re-quote bound');
  assert.match(text, /expire/i);
  assert.ok(text.includes(thorchainGatewayHost()), 'names the gateway host');
  assert.match(text, /\bIP\b/);
});

test('Confirm refuses a binding quote materially worse than the one shown, before any deposit is prepared', async () => {
  const { swap, calls } = market(-800);
  const shown = await indicative(swap);
  const before = calls.length;
  await assert.rejects(
    confirmThorchainSwap({ swap, quote: shown, toAddress: LTC_DEST, ownAddress: () => undefined }),
    (e: SwapError) => {
      assert.equal(e.code, 'quote_expired');
      assert.ok(e.message.includes('12.45633282'), 'names the figure the user saw');
      assert.ok(e.message.includes(String(Number((SHOWN_OUT * 9_200n) / 10_000n) / 1e8)), 'and the binding one');
      return true;
    },
  );
  const after = calls.slice(before);
  assert.ok(after.some((c) => c.includes('destination=')), 'the binding quote was asked for');
  assert.ok(after.every((c) => c.includes('/quote/swap')), 'and nothing toward a deposit followed');
});

test('Confirm goes ahead within the drift bound, and with a better market', async () => {
  for (const drift of [-20, 0, 150]) {
    const { swap } = market(drift);
    const shown = await indicative(swap);
    const sw = await confirmThorchainSwap({ swap, quote: shown, toAddress: LTC_DEST, ownAddress: () => undefined });
    assert.equal(sw.provider, 'thorchain');
    assert.equal(sw.depositAddress, MAIN.inbound_addresses[0].address);
    assert.equal(BigInt(sw.toAmountEstimateAtomic), (SHOWN_OUT * BigInt(10_000 + drift)) / 10_000n, `drift ${drift}`);
    assert.ok(sw.memo?.startsWith(`=:l:${LTC_DEST}:`));
  }
});
