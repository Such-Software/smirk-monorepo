/**
 * `signIn`: one approval covers connect and the login signature. The handler
 * must prompt exactly once, persist the grant only after approval, merge it
 * with any existing grant, refuse a denied or mismatched decision, and answer
 * with public keys taken from the signatures it was given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION, type SmirkAsset, type SmirkSignInResult } from '../protocol';

const ORIGIN = { origin: 'https://smirk.example', tabId: 7 };

function memStore(seed?: OriginPermission): OriginPermissionStore & { peek(o: string): OriginPermission | undefined } {
  const m = new Map<string, OriginPermission>();
  if (seed) m.set(seed.origin, seed);
  return {
    async get(o) { return m.get(o) ?? null; },
    async set(p) { m.set(p.origin, p); },
    async remove(o) { m.delete(o); },
    async list() { return [...m.values()]; },
    peek(o) { return m.get(o); },
  };
}

const lockedProvider: WalletProvider = {
  async isUnlocked() { return false; },
  async getPublicKeys() { return { btc: null, ltc: null, xmr: null, wow: null, grin: null }; },
  async getAddresses() { return { btc: null, ltc: null, xmr: null, wow: null, grin: null }; },
  async getNostrPublicKey() { return null; },
  async getBackendUrl() { return 'https://api.smirk.example'; },
};

function approving(): { handler: ApprovalHandler; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (req) => {
    seen.push(req);
    if (req.kind !== 'signIn') return { approved: false };
    return {
      kind: 'signIn',
      approved: true,
      approvedAssets: req.requestedAssets,
      result: {
        message: req.message,
        signatures: req.requestedAssets.map((asset) => ({ asset, signature: `sig-${asset}`, publicKey: `pub-${asset}` })),
      },
    };
  };
  return { handler, seen };
}

async function call(handler: ApprovalHandler, store: OriginPermissionStore, params: { message: string; assets?: SmirkAsset[] }) {
  const dispatch = createWalletHandler({ provider: lockedProvider, permissions: store, approval: handler });
  return dispatch({ type: 'SMIRK_REQUEST', v: PROTOCOL_VERSION, id: 1, method: 'signIn', params }, ORIGIN);
}

test('a new origin gets one prompt that connects and signs, then holds the grant', async () => {
  const store = memStore();
  const { handler, seen } = approving();
  const resp = await call(handler, store, { message: 'login challenge', assets: ['btc'] });
  assert.equal(resp.error, undefined);
  assert.equal(seen.length, 1);
  const req = seen[0]!;
  assert.equal(req.kind, 'signIn');
  assert.ok(req.kind === 'signIn' && !req.alreadyConnected);
  assert.deepEqual(store.peek(ORIGIN.origin)?.assets, ['btc']);
  const result = resp.result as SmirkSignInResult;
  assert.equal(result.publicKeys.btc, 'pub-btc');
  assert.equal(result.publicKeys.xmr, null);
  assert.equal(result.signatures.length, 1);
});

test('a connected origin still gets a prompt, marked as already connected, and keeps its grant', async () => {
  const store = memStore({ origin: ORIGIN.origin, assets: ['btc', 'xmr'], grantedAt: 1, lastUsedAt: 1, nostr: true } as OriginPermission);
  const { handler, seen } = approving();
  const resp = await call(handler, store, { message: 'again', assets: ['btc'] });
  assert.equal(resp.error, undefined);
  assert.equal(seen.length, 1);
  const req = seen[0]!;
  assert.ok(req.kind === 'signIn' && req.alreadyConnected);
  // The signature covers the existing grant, and other scopes survive the merge.
  assert.ok(req.kind === 'signIn' && req.requestedAssets.includes('xmr'));
  const perm = store.peek(ORIGIN.origin) as OriginPermission & { nostr?: boolean };
  assert.ok(perm.assets.includes('btc') && perm.assets.includes('xmr'));
  assert.equal(perm.nostr, true);
});

test('a denied sign-in grants nothing', async () => {
  const store = memStore();
  const handler: ApprovalHandler = async () => ({ approved: false });
  const resp = await call(handler, store, { message: 'login', assets: ['btc'] });
  assert.equal(resp.error?.code, 'USER_REJECTED');
  assert.equal(store.peek(ORIGIN.origin), undefined);
});

test('a decision of the wrong kind is refused and grants nothing', async () => {
  const store = memStore();
  const handler: ApprovalHandler = async () => ({ kind: 'connect', approved: true, approvedAssets: ['btc'] });
  const resp = await call(handler, store, { message: 'login', assets: ['btc'] });
  assert.equal(resp.error?.code, 'INTERNAL');
  assert.equal(store.peek(ORIGIN.origin), undefined);
});

test('an empty challenge is refused before any prompt', async () => {
  const store = memStore();
  const { handler, seen } = approving();
  const resp = await call(handler, store, { message: '' });
  assert.equal(resp.error?.code, 'INVALID_PARAMS');
  assert.equal(seen.length, 0);
});

test('public keys come only from approved assets in the signatures', async () => {
  const store = memStore();
  const handler: ApprovalHandler = async (req) => req.kind === 'signIn'
    ? {
        kind: 'signIn', approved: true, approvedAssets: ['btc'],
        result: { message: req.message, signatures: [
          { asset: 'btc', signature: 's', publicKey: 'pub-btc' },
          { asset: 'xmr', signature: 's', publicKey: 'pub-xmr' },
        ] },
      }
    : { approved: false };
  const resp = await call(handler, store, { message: 'login', assets: ['btc'] });
  const result = resp.result as SmirkSignInResult;
  assert.equal(result.publicKeys.btc, 'pub-btc');
  assert.equal(result.publicKeys.xmr, null);
});
