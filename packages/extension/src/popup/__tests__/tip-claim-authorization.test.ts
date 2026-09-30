import './_chrome-stub';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, type UnlockedWallet } from '@smirk/core';
import { walletKeystore } from '../singletons';
import { claimSocialTip, claimPublicTip, clawbackSocialTip } from '../tip-claim-handler';

test('claims and clawbacks refuse a revoked session before backend or tip-key work', async () => {
  const session = mock.method(walletKeystore, 'assertUnlockedWallet', () => { throw new Error('Wallet session was locked'); });
  const social = mock.method(api, 'claimSocialTip', async () => { throw new Error('backend must not run'); });
  const publicTip = mock.method(api, 'getPublicSocialTip', async () => { throw new Error('backend must not run'); });
  try {
    const wallet = { fingerprint: 'fixture' } as UnlockedWallet;
    for (const operation of [
      () => claimSocialTip(wallet, 'user', 'tip', 'btc'),
      () => claimPublicTip(wallet, 'user', 'tip', 'fragment'),
      () => clawbackSocialTip(wallet, 'user', 'tip'),
    ]) {
      const outcome = await operation();
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error, /locked/);
    }
    assert.equal(social.mock.callCount(), 0);
    assert.equal(publicTip.mock.callCount(), 0);
  } finally { session.mock.restore(); social.mock.restore(); publicTip.mock.restore(); }
});
