import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverLegacyFunds,
  legacyAccountsFor,
  legacyScanStartHeight,
  wipeLegacyAccounts,
  LEGACY_EPOCH_MS,
  type LegacyFinding,
} from '../legacy-recovery';
import * as legacy from '../legacy-recovery';
import type { ChainProviderRegistry } from '../chain/registry';
import type { UtxoEntry } from '../chain/types';
import type { KeyImageVerifier } from '../wallet-flow';

// The BIP-39 test vector. Not a funded wallet.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Addresses produced by the v0.2.4 extension's own derivation code
// (smirk-extension src/lib/hd.ts deriveAllKeys + src/lib/address.ts) for MNEMONIC,
// computed by running that code, not this one. If this module ever derives a
// different older address, a real user's old funds would be looked for in the
// wrong place, so these are pinned exactly.
const V024 = {
  btc: 'bc1qmxrw6qdh5g3ztfcwm0et5l8mvws4eva24kmp8m',
  ltc: 'ltc1qvh20q3zqd8ecsy3puf9md2vmr4f7qzx0gr07tr',
  v1xmr: '42CDNgcrB688DXgMSw62sv2H8QhkJaeEBfceSerWiqXW5yCFv5PH6Qydmfu5zgK9pNRS8sRkcAd2uAxtoV12sG2Y5kpXbbD',
  v1wow: 'Wo4c2UTVpce3bYFxEbwSREFG7qSBL1QKf5hJXH7FGh3ndi1u3wsqVjmB8eSUkcmnEXURAdbaUwBCEDLLNJdbkXxR2qiv2857K',
  v2xmr: '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR',
  v2wow: 'Wo4QCU357B96b79xKHCbmL6gj5uSwArGCfegF5RE1hXSE3crtrvDKjsZ9qs3iBsy1mbgD11abnPkWX7Rp5NFYSdi22NnfZVGZ',
};

test('older addresses match what the v0.2.4 wallet derived from the same seed', () => {
  const accounts = legacyAccountsFor(MNEMONIC);
  try {
    const by = (asset: string, source: string) =>
      accounts.find((a) => a.asset === asset && a.source === source)?.address;
    assert.equal(by('btc', 'm44'), V024.btc);
    assert.equal(by('ltc', 'm44'), V024.ltc);
    assert.equal(by('xmr', 'v1'), V024.v1xmr);
    assert.equal(by('wow', 'v1'), V024.v1wow);
    assert.equal(by('xmr', 'v2'), V024.v2xmr);
    assert.equal(by('wow', 'v2'), V024.v2wow);
    // BTC/LTC are one address each (v1 and v2 both used m/44').
    assert.equal(accounts.filter((a) => a.asset === 'btc').length, 1);
    assert.equal(accounts.length, 6);
  } finally {
    wipeLegacyAccounts(accounts);
  }
});

test('the current wallet address is never reported as an older one', () => {
  const accounts = legacyAccountsFor(MNEMONIC, { xmr: V024.v2xmr, btc: V024.btc });
  try {
    assert.equal(accounts.some((a) => a.address === V024.v2xmr), false);
    assert.equal(accounts.some((a) => a.address === V024.btc), false);
    assert.equal(accounts.some((a) => a.address === V024.v1xmr), true);
  } finally {
    wipeLegacyAccounts(accounts);
  }
});

test('wiping zeroes the key bytes', () => {
  const accounts = legacyAccountsFor(MNEMONIC);
  const held = accounts.map((a) => (a.kind === 'utxo' ? a.privateKey : a.privateSpendKey));
  wipeLegacyAccounts(accounts);
  for (const k of held) assert.equal(k.every((b) => b === 0), true);
});

test('scan start height stops at the Smirk epoch and at the operator depth', () => {
  const tip = 1_000_000;
  const now = LEGACY_EPOCH_MS + 10 * 86_400_000;
  assert.equal(legacyScanStartHeight('xmr', tip, now), tip - 10 * 720);
  assert.equal(legacyScanStartHeight('wow', tip, now), tip - 10 * 288);
  assert.equal(legacyScanStartHeight('xmr', tip, now, 3), tip - 3 * 720);
  assert.equal(legacyScanStartHeight('xmr', 100, now), 0);
});

// ---------------------------------------------------------------------------
// Discovery against fake providers
// ---------------------------------------------------------------------------

interface LwsFake {
  /** Per address: a balance payload, or an error string (unknown account). */
  balances: Map<string, unknown>;
  registered: Array<{ address: string; start?: number; nonce?: number }>;
  /** Balance served after registration, per address. */
  afterRegister?: Map<string, unknown>;
}

function providers(cfg: {
  utxos?: Partial<Record<'btc' | 'ltc', { utxos?: UtxoEntry[]; error?: string }>>;
  lws: Record<'xmr' | 'wow', LwsFake>;
  tip?: number;
}): ChainProviderRegistry {
  return {
    utxo: (asset: 'btc' | 'ltc') => ({
      async listOutputs(address: string) {
        const c = cfg.utxos?.[asset];
        if (c?.error) return { error: c.error };
        return { data: { asset, address, utxos: c?.utxos ?? [] } };
      },
    }),
    lws: (asset: 'xmr' | 'wow') => {
      const f = cfg.lws[asset];
      return {
        async getBalance(address: string) {
          const v = f.balances.get(address);
          if (v === undefined || typeof v === 'string') return { error: (v as string) ?? 'HTTP 403' };
          return { data: v };
        },
        async getHeight() {
          return { data: { height: cfg.tip ?? 3_000_000 } };
        },
        async registerAccount(_u: string, address: string, _vk: string, start?: number, _s?: number, nonce?: number) {
          f.registered.push({ address, ...(start !== undefined ? { start } : {}), ...(nonce !== undefined ? { nonce } : {}) });
          const after = f.afterRegister?.get(address);
          if (after !== undefined) f.balances.set(address, after);
          return { data: { success: true, message: 'ok' } };
        },
      };
    },
  } as unknown as ChainProviderRegistry;
}

const emptyLws = (): LwsFake => ({ balances: new Map(), registered: [] });

const balance = (o: Partial<{ total: number; locked: number; pending: number; spent: Array<{ amount: number; ki: string }>; scanned: number; tip: number }>) => ({
  total_received: String(o.total ?? 0),
  locked_balance: String(o.locked ?? 0),
  pending_balance: String(o.pending ?? 0),
  start_height: 100,
  scanned_height: o.scanned ?? 1000,
  blockchain_height: o.tip ?? 1000,
  spent_outputs: (o.spent ?? []).map((s, i) => ({ amount: String(s.amount), key_image: s.ki, tx_pub_key: 'aa', out_index: i })),
});

const find = (fs: LegacyFinding[], asset: string, source: string) =>
  fs.find((f) => f.asset === asset && f.source === source)!;

test('probe mode never registers an address the server does not watch', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  const fs = await discoverLegacyFunds(MNEMONIC, { providers: providers({ lws }), mode: 'probe', userId: 'u1' });
  assert.equal(lws.xmr.registered.length + lws.wow.registered.length, 0);
  assert.equal(find(fs, 'wow', 'v1').state, 'not-scanned');
  // Unknown is never "empty".
  assert.equal(fs.some((f) => (f.asset === 'xmr' || f.asset === 'wow') && f.state === 'empty'), false);
});

test('a watched older WOW address with 50 WOW reports it; ring decoys are not subtracted', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  // 50 WOW received; one candidate spend the server reports, but our key image
  // differs, so it is someone else's ring member (a decoy).
  lws.wow.balances.set(V024.v2wow, balance({ total: 50e11, spent: [{ amount: 50e11, ki: 'decoy' }] }));
  const verify: KeyImageVerifier = async () => 'ours-not-the-decoy';
  const fs = await discoverLegacyFunds(MNEMONIC, {
    providers: providers({ lws }),
    mode: 'probe',
    verifyKeyImage: verify,
  });
  const w = find(fs, 'wow', 'v2');
  assert.equal(w.state, 'funds');
  assert.equal(w.spendableAtomic, String(50e11));
  assert.equal(lws.wow.registered.length, 0);
});

test('a real spend confirmed by our key image is subtracted', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  lws.xmr.balances.set(V024.v1xmr, balance({ total: 7, spent: [{ amount: 7, ki: 'mine' }] }));
  const fs = await discoverLegacyFunds(MNEMONIC, {
    providers: providers({ lws }),
    mode: 'probe',
    verifyKeyImage: async () => 'mine',
  });
  assert.equal(find(fs, 'xmr', 'v1').state, 'empty');
  assert.equal(find(fs, 'xmr', 'v1').spendableAtomic, '0');
});

test('locked funds are reported as pending, not spendable', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  lws.wow.balances.set(V024.v1wow, balance({ total: 9, locked: 9 }));
  const fs = await discoverLegacyFunds(MNEMONIC, { providers: providers({ lws }), mode: 'probe', verifyKeyImage: async () => 'x' });
  const w = find(fs, 'wow', 'v1');
  assert.equal(w.state, 'funds');
  assert.equal(w.spendableAtomic, '0');
  assert.equal(w.pendingAtomic, '9');
});

test('scan mode registers only unknown addresses, from the epoch, then reports scanning', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  // v1 XMR is already watched: it must not be re-registered (that rewinds the cursor).
  lws.xmr.balances.set(V024.v1xmr, balance({ total: 0 }));
  lws.xmr.afterRegister = new Map([[V024.v2xmr, balance({ scanned: 10, tip: 1000 })]]);
  const tip = 3_000_000;
  const now = LEGACY_EPOCH_MS + 280 * 86_400_000;
  const fs = await discoverLegacyFunds(MNEMONIC, {
    providers: providers({ lws, tip }),
    mode: 'scan',
    userId: 'u1',
    now: () => now,
    restorePolicy: { pow_free_days: 90, pow_days_per_bit: 30, pow_max_bits: 24, max_depth_days: 365 },
  });
  assert.deepEqual(lws.xmr.registered.map((r) => r.address), [V024.v2xmr]);
  assert.equal(lws.xmr.registered[0]!.start, tip - 280 * 720);
  // Past the free window, a restore proof-of-work nonce is attached.
  assert.equal(typeof lws.xmr.registered[0]!.nonce, 'number');
  assert.equal(find(fs, 'xmr', 'v2').state, 'scanning');
  assert.equal(find(fs, 'xmr', 'v1').state, 'empty');
});

test('scan mode without a signed-in user reports an error, not empty', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  const fs = await discoverLegacyFunds(MNEMONIC, { providers: providers({ lws }), mode: 'scan', userId: null });
  assert.equal(find(fs, 'xmr', 'v1').state, 'error');
});

test('old BTC: confirmed is spendable, unconfirmed is pending; a failed read is an error', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  const u = (value: number, height: number): UtxoEntry => ({ txid: 'a'.repeat(64), vout: 0, value, height });
  const fs = await discoverLegacyFunds(MNEMONIC, {
    providers: providers({ lws, utxos: { btc: { utxos: [u(1000, 5), u(20, 0)] }, ltc: { error: 'down' } } }),
    mode: 'probe',
  });
  const b = find(fs, 'btc', 'm44');
  assert.equal(b.state, 'funds');
  assert.equal(b.spendableAtomic, '1000');
  assert.equal(b.pendingAtomic, '20');
  assert.equal(find(fs, 'ltc', 'm44').state, 'error');
});

// ---------------------------------------------------------------------------
// A refused sign-in (v0.3.1 live run, 2026-10-15: the automatic check ran at
// unlock, before the session token was back, and kept the refusals)
// ---------------------------------------------------------------------------

/** A backend that refuses every authenticated read, as it does without a session token. */
function signedOut(): { registry: ChainProviderRegistry; registered: string[] } {
  const refused = { error: 'Missing or invalid token', status: 401 };
  const registered: string[] = [];
  const registry = {
    utxo: () => ({ listOutputs: async () => refused }),
    lws: () => ({
      getBalance: async () => refused,
      getHeight: async () => ({ data: { height: 3_000_000 }, status: 200 }),
      registerAccount: async (_u: string, address: string) => {
        registered.push(address);
        return refused;
      },
    }),
  } as unknown as ChainProviderRegistry;
  return { registry, registered };
}

const isSignInRequired = (e: unknown) => e instanceof legacy.LegacySignInRequiredError;

test('a check refused for sign-in has no result, rather than unread or unwatched addresses', async () => {
  const { registry } = signedOut();
  await assert.rejects(discoverLegacyFunds(MNEMONIC, { providers: registry, mode: 'probe' }), isSignInRequired);
});

test('a Monero/Wownero read refused for sign-in is not reported as an address the server does not watch', async () => {
  // BTC/LTC read fine; only the light-wallet reads are refused.
  const { registry } = signedOut();
  const providers = {
    ...registry,
    utxo: (asset: 'btc' | 'ltc') => ({
      listOutputs: async (address: string) => ({ data: { asset, address, utxos: [] }, status: 200 }),
    }),
  } as unknown as ChainProviderRegistry;
  await assert.rejects(discoverLegacyFunds(MNEMONIC, { providers, mode: 'probe' }), isSignInRequired);
});

test('a scan refused for sign-in never asks the server to register an older address', async () => {
  const { registry, registered } = signedOut();
  await assert.rejects(
    discoverLegacyFunds(MNEMONIC, { providers: registry, mode: 'scan', userId: 'u1' }),
    isSignInRequired,
  );
  assert.deepEqual(registered, []);
});

test('an unreachable server still yields per-address unknowns, not a sign-in failure', async () => {
  const lws = { xmr: emptyLws(), wow: emptyLws() };
  const base = providers({ lws });
  const flaky = {
    ...base,
    utxo: () => ({ listOutputs: async () => ({ error: 'HTTP 503', status: 503 }) }),
    lws: (asset: 'xmr' | 'wow') => ({
      ...base.lws(asset),
      getBalance: async () => {
        throw new Error('Network error');
      },
    }),
  } as unknown as ChainProviderRegistry;
  const fs = await discoverLegacyFunds(MNEMONIC, { providers: flaky, mode: 'probe' });
  assert.equal(fs.filter((f) => f.asset === 'btc' || f.asset === 'ltc').every((f) => f.state === 'error'), true);
  assert.equal(fs.some((f) => f.state === 'empty' || f.state === 'funds'), false);
});
