/**
 * e2ee routing + permission gating in the wallet handler. The crypto itself is
 * KAT'd in @smirk/core (app-enc-seal.test.ts); here we prove the DISPATCH:
 * connection + unlock gates, the one-time e2ee disclosure (firstGrant), scope
 * persistence, the appSealOpen scope requirement, and that `domainScope` is the
 * VERIFIED origin (handler-set), never a page-supplied string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest, ApprovalResult } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION, APP_ENC_SCHEME, type SmirkMethod, type SmirkMethodMap } from '../protocol';

const ORIGIN = { origin: 'https://idp.wowne.ro' };

function memStore(seed?: OriginPermission): OriginPermissionStore {
  const m = new Map<string, OriginPermission>();
  if (seed) m.set(seed.origin, seed);
  return {
    async get(o) {
      return m.get(o) ?? null;
    },
    async set(p) {
      m.set(p.origin, p);
    },
    async remove(o) {
      m.delete(o);
    },
    async list() {
      return [...m.values()];
    },
  };
}

function fakeProvider(unlocked = true): WalletProvider {
  return {
    async isUnlocked() {
      return unlocked;
    },
    async getPublicKeys() {
      return { btc: null, ltc: null, xmr: null, wow: null, grin: null };
    },
    async getAddresses() {
      return { btc: null, ltc: null, xmr: null, wow: null, grin: null };
    },
    async getNostrPublicKey() {
      return null;
    },
    async getBackendUrl() {
      return 'https://api.smirk.cash';
    },
  };
}

/** An approval handler that always approves, records the requests it saw, and
 *  fabricates the executor's output (a stand-in for the real seed derivation). */
function recordingApproval(): { handler: ApprovalHandler; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (req) => {
    seen.push(req);
    if (req.kind === 'appEncKey') {
      return { kind: 'appEncKey', approved: true, publicKey: 'ab'.repeat(32) };
    }
    if (req.kind === 'appSealOpen') {
      return { kind: 'appSealOpen', approved: true, plaintext: 'cGxhaW4=' /* "plain" */ };
    }
    return { approved: false } as ApprovalResult;
  };
  return { handler, seen };
}

function connected(): OriginPermission {
  return { origin: ORIGIN.origin, assets: ['btc'], grantedAt: 1, lastUsedAt: 1 };
}

function req<M extends SmirkMethod>(method: M, params: SmirkMethodMap[M]['params']) {
  return { type: 'SMIRK_REQUEST' as const, v: PROTOCOL_VERSION, id: 1, method, params };
}

test('getAppEncryptionKey: NOT_CONNECTED when the origin has no permission', async () => {
  const { handler } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(),
    approval: handler,
  });
  const res = await dispatch(req('getAppEncryptionKey', {}), ORIGIN);
  assert.equal(res.error?.code, 'NOT_CONNECTED');
});

test('getAppEncryptionKey: LOCKED when the wallet is locked', async () => {
  const { handler } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('getAppEncryptionKey', {}), ORIGIN);
  assert.equal(res.error?.code, 'LOCKED');
});

test('getAppEncryptionKey: first use prompts firstGrant, persists scope, returns key+scheme', async () => {
  const { handler, seen } = recordingApproval();
  const store = memStore(connected());
  const dispatch = createWalletHandler({ provider: fakeProvider(), permissions: store, approval: handler });

  const res = await dispatch(req('getAppEncryptionKey', { context: 'sso' }), ORIGIN);

  assert.deepEqual(res.result, { publicKey: 'ab'.repeat(32), scheme: APP_ENC_SCHEME });
  const grant = seen[0];
  assert.equal(grant?.kind, 'appEncKey');
  assert.equal(grant.kind === 'appEncKey' && grant.firstGrant, true);
  // domainScope is the VERIFIED origin, not anything the page sent.
  assert.equal(grant.kind === 'appEncKey' && grant.domainScope, ORIGIN.origin);
  assert.equal(grant.kind === 'appEncKey' && grant.context, 'sso');
  // Scope now persisted.
  assert.equal((await store.get(ORIGIN.origin))?.e2ee, true);
});

test('getAppEncryptionKey: second call is a re-derive (firstGrant false)', async () => {
  const { handler, seen } = recordingApproval();
  const store = memStore({ ...connected(), e2ee: true });
  const dispatch = createWalletHandler({ provider: fakeProvider(), permissions: store, approval: handler });

  await dispatch(req('getAppEncryptionKey', {}), ORIGIN);

  assert.equal(seen[0]?.kind === 'appEncKey' && seen[0].firstGrant, false);
});

test('getAppEncryptionKey: user rejection surfaces USER_REJECTED', async () => {
  const dispatch = createWalletHandler({
    provider: fakeProvider(),
    permissions: memStore(connected()),
    approval: async () => ({ approved: false }),
  });
  const res = await dispatch(req('getAppEncryptionKey', {}), ORIGIN);
  assert.equal(res.error?.code, 'USER_REJECTED');
});

test('appSealOpen: NOT_AUTHORIZED without the e2ee scope', async () => {
  const { handler } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(),
    permissions: memStore(connected()), // no e2ee
    approval: handler,
  });
  const res = await dispatch(req('appSealOpen', { sealed: 'AAAA' }), ORIGIN);
  assert.equal(res.error?.code, 'NOT_AUTHORIZED');
});

test('appSealOpen: with scope, routes the sealed box + verified scope, returns plaintext', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(),
    permissions: memStore({ ...connected(), e2ee: true }),
    approval: handler,
  });
  const res = await dispatch(req('appSealOpen', { sealed: 'c2VhbGVk', context: 'sso' }), ORIGIN);

  assert.deepEqual(res.result, { plaintext: 'cGxhaW4=' });
  const open = seen[0];
  assert.equal(open?.kind, 'appSealOpen');
  assert.equal(open.kind === 'appSealOpen' && open.sealed, 'c2VhbGVk');
  assert.equal(open.kind === 'appSealOpen' && open.domainScope, ORIGIN.origin);
  assert.equal(open.kind === 'appSealOpen' && open.context, 'sso');
});
