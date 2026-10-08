import './_chrome-stub';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  bitcoinMessageHash,
  btcAddress,
  bytesToHex,
  chainProviders,
  createEncryptedTipPayload,
  createPublicTipPayload,
  generateUrlFragmentKey,
  legacyBtcLtcKey,
  type UnlockedWallet,
  type UtxoChainProvider,
} from '@smirk/core';
import { walletKeystore } from '../singletons';
import { claimLegacyTip, legacySignIn, listLegacyTips, LEGACY_API_BASE } from '../legacy-tips';
import { moveLegacyFunds } from '../legacy-funds';

// The BIP-39 test vector. Not a funded wallet.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Where swept coins must land: the wallet's own current address (any valid one here).
const OUR_BTC = btcAddress(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true));

const wallet = {
  fingerprint: 'legacy-fixture',
  mnemonic: MNEMONIC,
  addresses: { btc: OUR_BTC },
  keys: { btc: { privateKey: new Uint8Array(32).fill(9) } },
} as unknown as UnlockedWallet;

/** A fake legacy server: records requests, answers from a route table. */
function fakeServer(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; body: unknown; auth?: string | null }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = url.replace(LEGACY_API_BASE, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, body, auth: headers.Authorization ?? null });
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const r = handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fake BTC chain: one address holds the given UTXOs; broadcasts are captured. */
function fakeBtc(holder: string, utxos: Array<{ value: number; height: number }>) {
  const broadcasts: string[] = [];
  const provider = {
    async listOutputs(address: string) {
      return {
        data: {
          asset: 'btc',
          address,
          utxos:
            address === holder
              ? utxos.map((u, i) => ({ txid: 'ab'.repeat(32), vout: i, value: u.value, height: u.height }))
              : [],
        },
      };
    },
    async estimateFee() {
      return { data: { model: 'rate-estimate', fast: 5, normal: 2, slow: 1 } };
    },
    async broadcast(txHex: string) {
      broadcasts.push(txHex);
      return { data: { txid: 'f'.repeat(64) } };
    },
  } as unknown as UtxoChainProvider;
  return { provider, broadcasts };
}

function withUnlockedSession<T>(fn: () => Promise<T>): Promise<T> {
  const session = mock.method(walletKeystore, 'assertUnlockedWallet', () => undefined);
  return fn().finally(() => session.mock.restore());
}

test('sign-in uses only the old m/44\' key, never the seed fingerprint, and a valid signature', async () => {
  const server = fakeServer({
    'POST /auth/extension': () => ({ json: { access_token: 't', user: { id: 'u', is_new: false } } }),
  });
  const now = 1_790_000_000_000;
  const r = await legacySignIn(wallet, server.impl, now);
  assert.equal(r.data?.token, 't');
  const body = server.calls[0]!.body as Record<string, unknown>;
  // The fingerprint is what lets the old server re-key an account: never sent.
  assert.equal('seed_fingerprint' in body, false);
  const keys = body.keys as Array<{ asset: string; public_key: string }>;
  const legacy = legacyBtcLtcKey(MNEMONIC, 'btc');
  assert.deepEqual(keys, [{ asset: 'btc', public_key: bytesToHex(legacy.publicKey) }]);
  // BIP-137: header || r || s over the Bitcoin-message hash of smirk-auth-{ts}.
  const sig = Uint8Array.from(atob(String(body.signature)), (c) => c.charCodeAt(0));
  const ts = Math.floor(now / 1000);
  assert.equal(body.signed_timestamp, ts);
  const ok = secp256k1.verify(sig.slice(1), bitcoinMessageHash(`smirk-auth-${ts}`), legacy.publicKey, { prehash: false });
  assert.equal(ok, true);
});

test('a seed with no old account lists no tips (and never asks for them)', async () => {
  const server = fakeServer({
    'POST /auth/extension': () => ({ json: { access_token: 't', user: { id: 'u', is_new: true } } }),
  });
  const r = await listLegacyTips(wallet, server.impl);
  assert.deepEqual(r.data, []);
  assert.equal(server.calls.some((c) => c.path === '/tips/social/received'), false);
});

test('waiting tips are listed: pending and stuck claims, not finished ones', async () => {
  const server = fakeServer({
    'POST /auth/extension': () => ({ json: { access_token: 't', user: { id: 'u', is_new: false } } }),
    'GET /tips/social/received': () => ({
      json: {
        tips: [
          { id: 'a', asset: 'wow', amount: 15e11, status: 'claiming', is_public: false, sender_username: 'bob', sender_anonymous: false, funding_confirmations: 9, confirmations_required: 4, is_claimable: true, created_at: 'x' },
          { id: 'b', asset: 'wow', amount: 50e11, status: 'claimed', is_public: false, sender_anonymous: true, funding_confirmations: 9, confirmations_required: 4, is_claimable: false, created_at: 'x' },
        ],
      },
    }),
  });
  const r = await listLegacyTips(wallet, server.impl);
  assert.deepEqual(r.data?.map((t) => [t.id, t.status, t.senderLabel]), [['a', 'claiming', '@bob']]);
  assert.equal(server.calls.find((c) => c.path === '/tips/social/received')?.auth, 'Bearer t');
});

test('a targeted old tip is opened with the old key, swept to this wallet, and confirmed', async () => {
  // The tip as a v0.2.x sender made it: a random key, sealed to the recipient's
  // BTC key at the time (m/44'), ephemeral pubkey || ciphertext.
  const tipPriv = secp256k1.utils.randomPrivateKey();
  const tipAddr = btcAddress(secp256k1.getPublicKey(tipPriv, true));
  const sealed = createEncryptedTipPayload(tipPriv, legacyBtcLtcKey(MNEMONIC, 'btc').publicKey);
  const encryptedKey = sealed.ephemeralPubkey + sealed.encryptedKey;
  const chain = fakeBtc(tipAddr, [{ value: 50_000, height: 100 }]);
  const restore = chainProviders.utxo('btc');
  chainProviders.setUtxo('btc', chain.provider);
  const server = fakeServer({
    'POST /auth/extension': () => ({ json: { access_token: 't', user: { id: 'u', is_new: false } } }),
    'POST /tips/social/tip1/claim': () => ({ json: { success: true, encrypted_key: encryptedKey, tip_address: tipAddr } }),
    'GET /tips/social/tip1': () => ({ json: { asset: 'btc', amount: 50_000 } }),
    'POST /tips/social/tip1/confirm-sweep': () => ({ json: {} }),
  });
  try {
    const r = await withUnlockedSession(() => claimLegacyTip(wallet, 'tip1', { fetchImpl: server.impl }));
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    assert.equal(chain.broadcasts.length, 1);
    const tx = Transaction.fromRaw(hex.decode(chain.broadcasts[0]!));
    assert.equal(tx.outputsLength, 1);
    const out = tx.getOutput(0);
    // The single output pays this wallet (the address round-trips through the script).
    const expect = new Transaction();
    expect.addOutputAddress(OUR_BTC, 1n);
    assert.equal(hex.encode(out.script!), hex.encode(expect.getOutput(0).script!));
    assert.ok(out.amount! > 0n && out.amount! < 50_000n);
    await new Promise((res) => setTimeout(res, 10));
    const confirm = server.calls.find((c) => c.path === '/tips/social/tip1/confirm-sweep');
    assert.deepEqual(confirm?.body, { sweep_txid: 'f'.repeat(64) });
  } finally {
    chainProviders.setUtxo('btc', restore);
  }
});

test('a targeted tip is refused for a seed with no old account: no claim, no sweep', async () => {
  const chain = fakeBtc('nobody', []);
  const restore = chainProviders.utxo('btc');
  chainProviders.setUtxo('btc', chain.provider);
  const server = fakeServer({
    'POST /auth/extension': () => ({ json: { access_token: 't', user: { id: 'u', is_new: true } } }),
  });
  try {
    const r = await withUnlockedSession(() => claimLegacyTip(wallet, 'tip1', { fetchImpl: server.impl }));
    assert.equal(r.ok, false);
    assert.equal(server.calls.some((c) => c.path.endsWith('/claim')), false);
    assert.equal(chain.broadcasts.length, 0);
  } finally {
    chainProviders.setUtxo('btc', restore);
  }
});

test('a link tip still sweeps from its public description when the old server will not sign us in', async () => {
  const tipPriv = secp256k1.utils.randomPrivateKey();
  const tipAddr = btcAddress(secp256k1.getPublicKey(tipPriv, true));
  const frag = generateUrlFragmentKey();
  const chain = fakeBtc(tipAddr, [{ value: 30_000, height: 50 }]);
  const restore = chainProviders.utxo('btc');
  chainProviders.setUtxo('btc', chain.provider);
  const server = fakeServer({
    'POST /auth/extension': () => ({ status: 400, json: { error: 'Proof-of-work solution is required' } }),
    'GET /tips/social/tip2/public': () => ({
      json: {
        asset: 'btc',
        amount: 30_000,
        encrypted_key: createPublicTipPayload(tipPriv, frag.bytes),
        tip_address: tipAddr,
        is_claimable: true,
        funding_confirmations: 1,
        confirmations_required: 0,
      },
    }),
  });
  try {
    const r = await withUnlockedSession(() =>
      claimLegacyTip(wallet, 'tip2', { fragmentKey: frag.encoded, fetchImpl: server.impl }),
    );
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    assert.equal(chain.broadcasts.length, 1);
    assert.equal(server.calls.some((c) => c.path.endsWith('/confirm-sweep')), false);
  } finally {
    chainProviders.setUtxo('btc', restore);
  }
});

test('moving old BTC shows the amount and fee first, leaves unconfirmed coins, and cancel moves nothing', async () => {
  const old = legacyBtcLtcKey(MNEMONIC, 'btc').address;
  const chain = fakeBtc(old, [
    { value: 100_000, height: 10 },
    { value: 7_000, height: 0 }, // unconfirmed: stays for a later move
  ]);
  const restore = chainProviders.utxo('btc');
  chainProviders.setUtxo('btc', chain.provider);
  const finding = {
    asset: 'btc' as const,
    source: 'm44' as const,
    address: old,
    state: 'funds' as const,
    spendableAtomic: '100000',
    pendingAtomic: '7000',
  };
  try {
    // Cancel: nothing signed or broadcast.
    const cancelled = await withUnlockedSession(() =>
      moveLegacyFunds(wallet, finding, async () => {
        throw new Error('Not moved.');
      }),
    );
    assert.equal(cancelled.ok, false);
    assert.equal(chain.broadcasts.length, 0);

    // Confirm: the callback saw the exact numbers that were then broadcast.
    let seen: { amountAtomic: bigint; feeAtomic: bigint; unsettledAtomic: bigint } | undefined;
    const moved = await withUnlockedSession(() =>
      moveLegacyFunds(wallet, finding, async (s) => {
        seen = s;
      }),
    );
    assert.equal(moved.ok, true, moved.ok ? '' : moved.error);
    assert.equal(seen!.unsettledAtomic, 7_000n);
    assert.equal(seen!.amountAtomic + seen!.feeAtomic, 100_000n);
    const tx = Transaction.fromRaw(hex.decode(chain.broadcasts[0]!));
    assert.equal(tx.inputsLength, 1); // the unconfirmed output was left alone
    assert.equal(tx.getOutput(0).amount, seen!.amountAtomic);
  } finally {
    chainProviders.setUtxo('btc', restore);
  }
});
