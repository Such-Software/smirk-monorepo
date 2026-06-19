/**
 * Trocador SDK regression tests.
 *
 * Focus: contract correctness on the /new_trade query-param wire,
 * particularly the per-trade `passthrough` token that authenticates
 * webhook deliveries. Pre-2026-06-13 the wallet generated a per-swap
 * webhook_token and PUT it to the backend, but `SwapStartParams` had
 * no passthrough field so the token never reached `/new_trade`.
 * Every webhook delivery arrived with passthrough=null and the
 * backend's constant-time check rejected all of them. The 60s backup
 * poller silently masked it; primary push path was dead end-to-end.
 *
 * These tests pin the wire-level behavior so a future refactor
 * doesn't accidentally re-drop the passthrough.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TrocadorSwap } from '../index';
import type { SwapQuote } from '../index';

function trocadorWithFetchStub(fetchImpl: typeof fetch, opts?: { passthrough?: string; webhookUrl?: string }) {
  return new TrocadorSwap({
    apiKey: 'test-api-key',
    fetch: fetchImpl,
    ...(opts?.passthrough !== undefined ? { passthrough: opts.passthrough } : {}),
    ...(opts?.webhookUrl !== undefined ? { webhookUrl: opts.webhookUrl } : {}),
  });
}

function fakeQuote(impl: { tradeId: string; provider: string; amountFromDecimal: string; amountToDecimal: string }): SwapQuote {
  return {
    fromAsset: 'btc',
    toAsset: 'ltc',
    fromAmount: '100000',
    toAmountEstimate: '50000',
    feeEstimate: '0',
    etaSeconds: 600,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    kind: 'aggregator',
    implementationData: impl,
  };
}

function fakeNewTradeResponse() {
  return new Response(
    JSON.stringify({
      trade_id: 'TRADE-XYZ',
      address_provider: 'ltc1qfakedepositaddress',
      ticker_from: 'btc',
      ticker_to: 'ltc',
      coin_from: 'BTC',
      coin_to: 'LTC',
      network_from: 'Mainnet',
      network_to: 'Mainnet',
      amount_from: '0.001',
      amount_to: '0.05',
      provider: 'fakeProvider',
      fixed: false,
      payment: false,
      status: 'new',
      quotes: { quotes: [] },
      address_provider_memo: '',
      address_user: 'btc1q',
      address_user_memo: '',
      refund_address: 'btc1qrefund',
      refund_address_memo: '',
      password: '',
      id_provider: 'pid',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('TrocadorSwap.start passthrough wiring', () => {
  it('forwards per-trade passthrough into /new_trade query params', async () => {
    let calledUrl: string | null = null;
    const fetchImpl: typeof fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : (input as Request).url;
      return fakeNewTradeResponse();
    };
    const trocador = trocadorWithFetchStub(fetchImpl);
    await trocador.start({
      quote: fakeQuote({
        tradeId: 'TRADE-XYZ',
        provider: 'fakeProvider',
        amountFromDecimal: '0.001',
        amountToDecimal: '0.05',
      }),
      toAddress: 'ltc1qfakerecipient',
      refundAddress: 'btc1qfakerefund',
      passthrough: 'per-trade-token-abc',
    });
    assert.ok(calledUrl, 'fetch was called');
    const url = new URL(calledUrl!);
    assert.equal(
      url.searchParams.get('passthrough'),
      'per-trade-token-abc',
      'per-trade passthrough must be in /new_trade URL',
    );
  });

  it('per-trade passthrough takes precedence over constructor default', async () => {
    let calledUrl: string | null = null;
    const fetchImpl: typeof fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : (input as Request).url;
      return fakeNewTradeResponse();
    };
    const trocador = trocadorWithFetchStub(fetchImpl, { passthrough: 'CONSTRUCTOR-DEFAULT' });
    await trocador.start({
      quote: fakeQuote({
        tradeId: 'TRADE-XYZ',
        provider: 'fakeProvider',
        amountFromDecimal: '0.001',
        amountToDecimal: '0.05',
      }),
      toAddress: 'ltc1q',
      refundAddress: 'btc1q',
      passthrough: 'PER-TRADE-WINS',
    });
    const url = new URL(calledUrl!);
    assert.equal(url.searchParams.get('passthrough'), 'PER-TRADE-WINS');
  });

  it('falls back to constructor passthrough when start() params omit it', async () => {
    let calledUrl: string | null = null;
    const fetchImpl: typeof fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : (input as Request).url;
      return fakeNewTradeResponse();
    };
    const trocador = trocadorWithFetchStub(fetchImpl, { passthrough: 'CONSTRUCTOR-DEFAULT' });
    await trocador.start({
      quote: fakeQuote({
        tradeId: 'TRADE-XYZ',
        provider: 'fakeProvider',
        amountFromDecimal: '0.001',
        amountToDecimal: '0.05',
      }),
      toAddress: 'ltc1q',
      refundAddress: 'btc1q',
    });
    const url = new URL(calledUrl!);
    assert.equal(url.searchParams.get('passthrough'), 'CONSTRUCTOR-DEFAULT');
  });

  it('omits passthrough param entirely when neither caller nor constructor supplies one', async () => {
    let calledUrl: string | null = null;
    const fetchImpl: typeof fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : (input as Request).url;
      return fakeNewTradeResponse();
    };
    const trocador = trocadorWithFetchStub(fetchImpl);
    await trocador.start({
      quote: fakeQuote({
        tradeId: 'TRADE-XYZ',
        provider: 'fakeProvider',
        amountFromDecimal: '0.001',
        amountToDecimal: '0.05',
      }),
      toAddress: 'ltc1q',
      refundAddress: 'btc1q',
    });
    const url = new URL(calledUrl!);
    // null === "param not present" in URLSearchParams
    assert.equal(url.searchParams.get('passthrough'), null);
  });
});
