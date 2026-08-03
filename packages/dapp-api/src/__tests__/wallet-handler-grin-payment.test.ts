/**
 * Money gate G14: in-page Grin payments are HONESTLY REJECTED.
 *
 * A dapp-initiated grin send is deferred to v0.4: the interactive path would
 * write finalize context into a SendWizard slot it never populates, so the
 * returned S2 could never finalize and would lock the user's inputs for ~7
 * days (a real fund-availability bug). Until that is fixed, requestPayment with
 * asset === 'grin' must fail closed with UNSUPPORTED_ASSET and MUST NOT reach
 * the approval handler (no popup, no send).
 *
 * Crucially the rejection is a CAPABILITY boundary, not an authorization
 * result: it must fire the same way whether or not the origin holds a grin
 * scope grant. That is what stops it from leaking as "you're not authorized".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION } from '../protocol';

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

function fakeProvider(unlocked: boolean): WalletProvider {
  const empty = { btc: null, ltc: null, xmr: null, wow: null, grin: null };
  return {
    async isUnlocked() {
      return unlocked;
    },
    async getPublicKeys() {
      return empty;
    },
    async getAddresses() {
      return empty;
    },
    async getNostrPublicKey() {
      return null;
    },
    async getBackendUrl() {
      return 'https://api.smirk.cash';
    },
  };
}

/** Counting approval handler: should never be invoked for a grin payment. */
function countingApproval(): { handler: ApprovalHandler; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  const handler: ApprovalHandler = async (req) => {
    seen.push(req);
    // Fabricate a success so that IF the guard failed to short-circuit, the
    // test's `success !== true` / code assertions would clearly catch it.
    if (req.kind === 'requestPayment') {
      return { kind: 'requestPayment', approved: true, result: { success: true, txid: 'tx' } };
    }
    return { approved: false };
  };
  return { handler, seen };
}

function grinPaymentReq() {
  return {
    type: 'SMIRK_REQUEST' as const,
    v: PROTOCOL_VERSION,
    id: 1,
    method: 'requestPayment' as const,
    // asset 'grin' is not in requestPayment's params type; cast at the wire
    // boundary to model a hostile/incorrect page sending it anyway.
    params: { asset: 'grin', amount: '1', address: 'grin1xyz' } as unknown as {
      asset: 'btc' | 'ltc' | 'xmr' | 'wow';
      amount: string;
      address: string;
    },
  };
}

function connected(assets: OriginPermission['assets']): OriginPermission {
  return { origin: ORIGIN.origin, assets, grantedAt: 1, lastUsedAt: 1 };
}

test('requestPayment(grin): rejected with UNSUPPORTED_ASSET, approval never called (origin lacks grin scope)', async () => {
  const { handler, seen } = countingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected(['btc', 'ltc', 'xmr', 'wow'])),
    approval: handler,
  });
  const res = await dispatch(grinPaymentReq(), ORIGIN);
  assert.equal(res.error?.code, 'UNSUPPORTED_ASSET');
  assert.equal(seen.length, 0, 'approval handler must not be invoked');
});

test('requestPayment(grin): rejected with UNSUPPORTED_ASSET even WITH a grin scope grant (capability boundary, not auth)', async () => {
  const { handler, seen } = countingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected(['btc', 'ltc', 'xmr', 'wow', 'grin'])),
    approval: handler,
  });
  const res = await dispatch(grinPaymentReq(), ORIGIN);
  assert.equal(res.error?.code, 'UNSUPPORTED_ASSET');
  assert.notEqual(res.error?.code, 'NOT_AUTHORIZED');
  assert.equal(seen.length, 0, 'approval handler must not be invoked');
});

test('requestPayment(grin): rejection is independent of grin scope grant (same code either way)', async () => {
  const withoutGrant = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected(['btc'])),
    approval: countingApproval().handler,
  });
  const withGrant = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected(['btc', 'grin'])),
    approval: countingApproval().handler,
  });
  const a = await withoutGrant(grinPaymentReq(), ORIGIN);
  const b = await withGrant(grinPaymentReq(), ORIGIN);
  assert.equal(a.error?.code, 'UNSUPPORTED_ASSET');
  assert.equal(b.error?.code, a.error?.code);
});

test('requestPayment(btc): still routes through approval (guard does not over-block supported assets)', async () => {
  const { handler, seen } = countingApproval();
  const dispatch = createWalletHandler({
    provider: fakeProvider(true),
    permissions: memStore(connected(['btc'])),
    approval: handler,
  });
  const res = await dispatch(
    {
      type: 'SMIRK_REQUEST',
      v: PROTOCOL_VERSION,
      id: 2,
      method: 'requestPayment',
      params: { asset: 'btc', amount: '1', address: 'bc1qx' },
    },
    ORIGIN,
  );
  assert.equal(res.error, undefined);
  assert.equal((res.result as { success: boolean })?.success, true);
  assert.equal(seen[0]?.kind, 'requestPayment');
});
