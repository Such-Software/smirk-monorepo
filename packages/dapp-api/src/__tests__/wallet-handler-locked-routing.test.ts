/**
 * Locked-wallet → approval routing. The security-sensitive methods must NOT
 * short-circuit with a `LOCKED` error before the approval popup can open. A
 * locked wallet opens the approval popup, whose ApprovalApp renders the unlock
 * screen; only after the user unlocks does the approved result resolve.
 *
 * These tests exercise the wallet-handler dispatch with a LOCKED provider and a
 * recording approval handler that stands in for "user unlocked + approved in the
 * popup". The assertion is: locked sensitive methods route THROUGH the approval
 * handler (so the popup gets a chance to open) instead of returning LOCKED.
 *
 * Passive metadata reads (getPublicKeys / getAddresses / getBackend) have no
 * approval UI and are intentionally still LOCKED-gated — see the tail tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest, ApprovalResult } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION, type SmirkMethod, type SmirkMethodMap } from '../protocol';

const ORIGIN = { origin: 'https://dapp.example' };

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

/** A provider whose lock state is fixed at construction. When locked it mirrors
 *  the real chrome public-cache provider: reads return empty/null material. */
function fakeProvider(unlocked: boolean): WalletProvider {
  const empty = { btc: null, ltc: null, xmr: null, wow: null, grin: null };
  return {
    async isUnlocked() {
      return unlocked;
    },
    async getPublicKeys() {
      return unlocked ? { ...empty, btc: 'pub-btc' } : empty;
    },
    async getAddresses() {
      return empty;
    },
    async getNostrPublicKey() {
      return unlocked ? 'ab'.repeat(32) : null;
    },
    async getBackendUrl() {
      return 'https://api.smirk.cash';
    },
  };
}

/** Approves everything, fabricating each executor result. Records requests. */
function recordingApproval(): { handler: ApprovalHandler; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (req) => {
    seen.push(req);
    switch (req.kind) {
      case 'connect':
        return { kind: 'connect', approved: true, approvedAssets: req.requestedAssets };
      case 'signMessage':
        return {
          kind: 'signMessage',
          approved: true,
          result: { message: req.message, signatures: [] },
        };
      case 'requestPayment':
        return { kind: 'requestPayment', approved: true, result: { success: true, txid: 'tx' } };
      case 'claimPublicTip':
        return { kind: 'claimPublicTip', approved: true, result: { success: true, txid: 'tx' } };
      case 'nostrGrant':
        return { kind: 'nostrGrant', approved: true };
      case 'signNostrEvent':
        return {
          kind: 'signNostrEvent',
          approved: true,
          result: {
            id: 'id',
            pubkey: 'pk',
            created_at: 0,
            kind: req.event.kind,
            tags: [],
            content: req.event.content,
            sig: 'sig',
          },
        };
      case 'nostrCrypt':
        return { kind: 'nostrCrypt', approved: true, data: `out:${req.op}` };
      case 'appEncKey':
        return { kind: 'appEncKey', approved: true, publicKey: 'ab'.repeat(32) };
      case 'appSealOpen':
        return { kind: 'appSealOpen', approved: true, plaintext: 'cGxhaW4=' };
      default:
        return { approved: false } as ApprovalResult;
    }
  };
  return { handler, seen };
}

/** Rejects everything — stands in for the user closing the popup. */
const rejectAll: ApprovalHandler = async () => ({ approved: false });

function req<M extends SmirkMethod>(method: M, params: SmirkMethodMap[M]['params']) {
  return { type: 'SMIRK_REQUEST' as const, v: PROTOCOL_VERSION, id: 1, method, params };
}

function connected(extra?: Partial<OriginPermission>): OriginPermission {
  return { origin: ORIGIN.origin, assets: ['btc', 'ltc', 'xmr', 'wow'], grantedAt: 1, lastUsedAt: 1, ...extra };
}

// ── connect ─────────────────────────────────────────────────────────────────

test('connect: locked + already-authorized routes through approval, not LOCKED or silent-serve', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('connect', { assets: ['btc'] }), ORIGIN);
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'connect'); // popup opened instead of fast-path
});

test('connect: unlocked + already-authorized keeps the silent fast path (no prompt)', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('connect', { assets: ['btc'] }), ORIGIN);
  assert.equal(seen.length, 0); // no approval — served straight from cache
  assert.equal((res.result as { btc: string | null })?.btc, 'pub-btc');
});

test('connect: locked + user closes popup surfaces USER_REJECTED', async () => {
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: rejectAll,
  });
  const res = await dispatch(req('connect', { assets: ['btc'] }), ORIGIN);
  assert.equal(res.error?.code, 'USER_REJECTED');
});

// ── signMessage / requestPayment / claimPublicTip / signNostrEvent ───────────

test('signMessage: locked routes through approval, not LOCKED', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('signMessage', { message: 'hi' }), ORIGIN);
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'signMessage');
  assert.equal((res.result as { message: string })?.message, 'hi');
});

test('signMessage: locked + user closes popup surfaces USER_REJECTED', async () => {
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: rejectAll,
  });
  const res = await dispatch(req('signMessage', { message: 'hi' }), ORIGIN);
  assert.equal(res.error?.code, 'USER_REJECTED');
});

test('requestPayment: locked routes through approval, not LOCKED', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(
    req('requestPayment', { asset: 'btc', amount: '1000', address: 'bc1qx' }),
    ORIGIN,
  );
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'requestPayment');
  assert.equal((res.result as { success: boolean })?.success, true);
});

test('claimPublicTip: locked routes through approval, not LOCKED', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(),
    approval: handler,
  });
  const res = await dispatch(req('claimPublicTip', { tipId: 't1', fragmentKey: 'k' }), ORIGIN);
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'claimPublicTip');
});

test('signNostrEvent: locked routes through approval, not LOCKED', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected({ nostr: true })),
    approval: handler,
  });
  const res = await dispatch(req('signNostrEvent', { event: { kind: 1, content: '', tags: [] } }), ORIGIN);
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'signNostrEvent');
});

// ── getNostrPublicKey ────────────────────────────────────────────────────────

test('getNostrPublicKey: locked + already-granted routes through approval (does not serve from empty cache)', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected({ nostr: true })),
    approval: handler,
  });
  const res = await dispatch(req('getNostrPublicKey', {}), ORIGIN);
  assert.notEqual(res.error?.code, 'LOCKED');
  assert.equal(seen[0]?.kind, 'nostrGrant'); // popup opened → unlock → serve npub
});

test('getNostrPublicKey: unlocked + already-granted serves the npub silently (no prompt)', async () => {
  const { handler, seen } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected({ nostr: true })),
    approval: handler,
  });
  const res = await dispatch(req('getNostrPublicKey', {}), ORIGIN);
  assert.equal(seen.length, 0);
  assert.equal(res.result, 'ab'.repeat(32));
});

test('getNostrPublicKey: locked + already-granted, user closes popup surfaces USER_REJECTED', async () => {
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected({ nostr: true })),
    approval: rejectAll,
  });
  const res = await dispatch(req('getNostrPublicKey', {}), ORIGIN);
  assert.equal(res.error?.code, 'USER_REJECTED');
});

// ── passive reads stay LOCKED-gated (no approval UI to open) ──────────────────

test('getPublicKeys: still returns LOCKED when locked (passive read, no popup)', async () => {
  const { handler } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('getPublicKeys', {}), ORIGIN);
  assert.equal(res.error?.code, 'LOCKED');
});

test('getBackend: still returns LOCKED when locked (passive read, no popup)', async () => {
  const { handler } = recordingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(false),
    permissions: memStore(connected()),
    approval: handler,
  });
  const res = await dispatch(req('getBackend', {}), ORIGIN);
  assert.equal(res.error?.code, 'LOCKED');
});
