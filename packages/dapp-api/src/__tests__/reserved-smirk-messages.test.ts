/**
 * The handler refuses a message in the reserved `smirk-` namespace before it
 * prompts. A prompt for a signature the wallet will not produce would teach the
 * user to approve something misleading ("Sign in to this site? It cannot move
 * funds."), and the signer behind it is the second line, not the only one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION } from '../protocol';
import {
  isReservedSmirkMessage,
  signableMessageRefusal,
  websiteChallengeOriginRefusal,
} from '../reserved-messages';

const ORIGIN = { origin: 'https://attacker.example', tabId: 3 };

function store(seed?: OriginPermission): OriginPermissionStore {
  const m = new Map<string, OriginPermission>();
  if (seed) m.set(seed.origin, seed);
  return {
    async get(o) { return m.get(o) ?? null; },
    async set(p) { m.set(p.origin, p); },
    async remove(o) { m.delete(o); },
    async list() { return [...m.values()]; },
  };
}

const provider: WalletProvider = {
  async isUnlocked() { return true; },
  async getPublicKeys() { return { btc: 'pub', ltc: null, xmr: null, wow: null, grin: null }; },
  async getAddresses() { return { btc: null, ltc: null, xmr: null, wow: null, grin: null }; },
  async getNostrPublicKey() { return null; },
  async getBackendUrl() { return 'https://api.smirk.cash'; },
};

function recordingApproval(): { handler: ApprovalHandler; seen: ApprovalRequest[] } {
  const seen: ApprovalRequest[] = [];
  return {
    seen,
    handler: async (req) => {
      seen.push(req);
      return { approved: false };
    },
  };
}

const NOW = Math.floor(Date.now() / 1000);
/** The rotation proof servers accept (v2), and the one they no longer do. */
const ROTATION = `smirk-auth-rotate-v2|https://api.smirk.cash/api/v1|${'ab'.repeat(32)}|${NOW}`;
const ROTATION_V1 = `smirk-rotate-v1|https://api.smirk.cash/api/v1|${'ab'.repeat(32)}|${NOW}`;

for (const [method, message] of [
  ['signIn', ROTATION],
  ['signMessage', ROTATION],
  ['signIn', ROTATION_V1],
  ['signMessage', ROTATION_V1],
] as const) {
  test(`${method} refuses a rotation proof without prompting: ${message.slice(0, 20)}`, async () => {
    const { handler, seen } = recordingApproval();
    const dispatch = createWalletHandler({
      provider,
      permissions: store({ origin: ORIGIN.origin, assets: ['btc'], grantedAt: 1, lastUsedAt: 1 } as OriginPermission),
      approval: handler,
    });
    const resp = await dispatch(
      { type: 'SMIRK_REQUEST', v: PROTOCOL_VERSION, id: 1, method, params: { message, assets: ['btc'] } },
      ORIGIN,
    );
    assert.equal(resp.error?.code, 'INVALID_PARAMS');
    assert.match(resp.error?.message ?? '', /reserved/i);
    assert.equal(seen.length, 0, 'the user is never asked');
  });
}

test('the namespace is the whole smirk- prefix, case- and padding-insensitive, and nothing else', () => {
  for (const m of [ROTATION, ROTATION_V1, 'smirk-auth-1', '  SMIRK-auth-1', '\nsmirk-next-proof']) {
    assert.equal(isReservedSmirkMessage(m), true, m);
  }
  for (const m of ['Smirk Authentication Challenge\nNonce: 00', 'login to smirk-example.com', 'smirk', '']) {
    assert.equal(isReservedSmirkMessage(m), false, m);
  }
});

/**
 * Values that are not a primitive string. Each one turns into a reserved
 * proof, a Smirk challenge, or other text once a signer encodes it, and a
 * guard that looked at strings only let every one of them through (REGRESSION,
 * 2026-10-09 round 4 review: `['smirk-auth-1']` signed as `smirk-auth-1`).
 */
const NOT_TEXT: readonly unknown[] = [
  [ROTATION],
  ['smirk-auth-1'],
  [challengeFor('https://smirk.cash')],
  { toString: () => ROTATION },
  { message: ROTATION },
  42,
  0,
  true,
  null,
  undefined,
  new String(ROTATION),
  new String('hello'),
];

function challengeFor(origin: string): string {
  return `Smirk Authentication Challenge\nNonce: 00\nOrigin: ${origin}\nTimestamp: 1`;
}

test('anything that is not text fails closed in every guard', () => {
  for (const m of NOT_TEXT) {
    assert.equal(isReservedSmirkMessage(m), true, `reserved: ${String(m)}`);
    assert.ok(signableMessageRefusal(m), `unsignable: ${String(m)}`);
    assert.ok(websiteChallengeOriginRefusal(m, 'https://smirk.cash'), `challenge: ${String(m)}`);
  }
  assert.ok(signableMessageRefusal(''), 'an empty message is not signed either');
  assert.equal(signableMessageRefusal('hello'), null);
});

for (const method of ['signIn', 'signMessage'] as const) {
  for (const message of [...NOT_TEXT, '']) {
    test(`${method} refuses a message that is not non-empty text, before asking: ${String(message).slice(0, 24)}`, async () => {
      const { handler, seen } = recordingApproval();
      let permissionReads = 0;
      const permissions = store({ origin: ORIGIN.origin, assets: ['btc'], grantedAt: 1, lastUsedAt: 1 } as OriginPermission);
      const counting: OriginPermissionStore = {
        ...permissions,
        async get(o) {
          permissionReads += 1;
          return permissions.get(o);
        },
      };
      const dispatch = createWalletHandler({ provider, permissions: counting, approval: handler });
      const resp = await dispatch(
        { type: 'SMIRK_REQUEST', v: PROTOCOL_VERSION, id: 1, method, params: { message, assets: ['btc'] } } as never,
        ORIGIN,
      );
      assert.equal(resp.error?.code, 'INVALID_PARAMS');
      assert.match(resp.error?.message ?? '', /Refusing to sign/);
      assert.equal(seen.length, 0, 'the user is never asked');
      assert.equal(permissionReads, 0, 'refused before any other check');
    });
  }
}
