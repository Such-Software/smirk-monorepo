/**
 * A Smirk server's website sign-in challenge is meant to be signed through the
 * dapp surface, by the website it names, and the server trades the signature
 * for a full session. A site that got a challenge naming another site signed
 * (or one it fetched from the server itself) could sign in to that server as
 * the user, so the handler refuses it before prompting unless the challenge
 * names the requesting site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWalletHandler } from '../wallet-handler';
import type { ApprovalHandler, ApprovalRequest } from '../approval';
import type { OriginPermission, OriginPermissionStore } from '../permissions';
import type { WalletProvider } from '../provider';
import { PROTOCOL_VERSION } from '../protocol';
import { websiteChallengeOriginRefusal } from '../reserved-messages';

function store(seed: OriginPermission): OriginPermissionStore {
  const m = new Map<string, OriginPermission>([[seed.origin, seed]]);
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

/** The challenge exactly as `/auth/website/challenge` issues it. */
function challenge(origin: string): string {
  return `Smirk Authentication Challenge\nNonce: ${'ab'.repeat(16)}\nOrigin: ${origin}\nTimestamp: 1790000000`;
}

async function ask(method: 'signIn' | 'signMessage', requester: string, message: string) {
  const seen: ApprovalRequest[] = [];
  const approval: ApprovalHandler = async (req) => {
    seen.push(req);
    return { approved: false };
  };
  const dispatch = createWalletHandler({
    provider,
    permissions: store({ origin: requester, assets: ['btc'], grantedAt: 1, lastUsedAt: 1 } as OriginPermission),
    approval,
  });
  const resp = await dispatch(
    { type: 'SMIRK_REQUEST', v: PROTOCOL_VERSION, id: 1, method, params: { message, assets: ['btc'] } },
    { origin: requester, tabId: 3 },
  );
  return { resp, seen };
}

for (const method of ['signIn', 'signMessage'] as const) {
  test(`${method} refuses another site's Smirk challenge without prompting`, async () => {
    const { resp, seen } = await ask(method, 'https://attacker.example', challenge('https://smirk.cash'));
    assert.equal(resp.error?.code, 'INVALID_PARAMS');
    assert.match(resp.error?.message ?? '', /only sign in to Smirk as itself/);
    assert.equal(seen.length, 0, 'the user is never asked');
  });

  test(`${method} still asks the user about a site's own Smirk challenge`, async () => {
    const { seen } = await ask(method, 'https://smirk.cash', challenge('https://smirk.cash'));
    assert.equal(seen.length, 1);
  });
}

test('a Smirk challenge binds to exactly one origin; other messages are not its business', () => {
  assert.equal(websiteChallengeOriginRefusal(challenge('https://smirk.cash/'), 'https://SMIRK.cash'), null);
  assert.ok(websiteChallengeOriginRefusal(challenge('https://smirk.cash'), 'https://smirk.cash.evil.example'));
  assert.ok(websiteChallengeOriginRefusal(challenge('http://smirk.cash'), 'https://smirk.cash'));
  assert.ok(
    websiteChallengeOriginRefusal('Smirk Authentication Challenge\nNonce: 00\nTimestamp: 1', 'https://smirk.cash'),
    'a challenge naming no site',
  );
  assert.ok(
    websiteChallengeOriginRefusal(
      `${challenge('https://smirk.cash')}\nOrigin: https://attacker.example`,
      'https://smirk.cash',
    ),
    'a challenge naming two sites',
  );
  for (const m of ['Sign in to example.com\nOrigin: https://smirk.cash', 'hello', 42, undefined]) {
    assert.equal(websiteChallengeOriginRefusal(m, 'https://attacker.example'), null, String(m));
  }
});
