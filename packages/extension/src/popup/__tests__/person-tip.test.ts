/**
 * Person tips: recipient resolution and the delivery policy that runs after a
 * tip is funded. Funds have left the wallet by then, so delivery trouble must
 * surface as a warning with the link as a fallback, never as a failed tip.
 */
import './_chrome-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeNpub, generateBurnerIdentity, hexToBytes, type resolveNip05 } from '@smirk/core';
import type { TipSubmitFields, TipSubmitOutcome } from '@smirk/ui';
import { resolveTipRecipient } from '../tip-recipient';
import { deliverPersonTipOutcome } from '../tip-person';

const bob = generateBurnerIdentity();

const fakeResolve = (map: Record<string, string>): typeof resolveNip05 =>
  (async (identifier: string, opts?: { homeDomain?: string }) => {
    const full = identifier.includes('@') ? identifier : `${identifier}@${opts?.homeDomain}`;
    const pubkeyHex = map[full.toLowerCase()];
    return pubkeyHex
      ? { ok: true, resolution: { pubkeyHex, relays: [] } }
      : { ok: false, error: 'not-found' };
  }) as unknown as typeof resolveNip05;

test('recipient: an npub resolves without a lookup', async () => {
  let looked = false;
  const npub = encodeNpub(hexToBytes(bob.pubkeyHex));
  const r = await resolveTipRecipient(npub, {
    resolve: (async () => {
      looked = true;
      return { ok: false, error: 'not-found' };
    }) as unknown as typeof resolveNip05,
    homeDomain: 'smirk.test',
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.recipient.pubkeyHex, bob.pubkeyHex);
  assert.equal(looked, false);
});

test('recipient: a bare username resolves on the home domain', async () => {
  const r = await resolveTipRecipient('@Alice', {
    resolve: fakeResolve({ 'alice@smirk.test': bob.pubkeyHex }),
    homeDomain: 'smirk.test',
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.recipient.pubkeyHex, bob.pubkeyHex);
    assert.equal(r.recipient.display, '@alice');
  }
});

test('recipient: an unknown name is a clear error, not a throw', async () => {
  const r = await resolveTipRecipient('nobody@smirk.test', { resolve: fakeResolve({}), homeDomain: 'smirk.test' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no one/i);
});

const TIP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const funded: Extract<TipSubmitOutcome, { ok: true }> = {
  ok: true,
  tipId: TIP_ID,
  shareUrl: `https://smirk.test/tip/${TIP_ID}#claimKeyClaimKeyClaimKeyClaimKey01234`,
  shareUrlPending: false,
};
const fields = (extra: Partial<TipSubmitFields> = {}): TipSubmitFields => ({
  username: '',
  platform: 'smirk',
  assetId: 'xmr',
  amountAtomic: 1_000_000n,
  isPublic: true,
  senderAnonymous: false,
  recipient: { pubkeyHex: bob.pubkeyHex, display: '@bob' },
  memo: 'thanks',
  expiresAt: 1_900_000_000,
  ...extra,
});

test('delivery: the claim key from the link is what gets delivered', async () => {
  let sent: unknown;
  const out = await deliverPersonTipOutcome(funded, fields(), async (to, tip) => {
    sent = { to, ...tip };
    return { selfCopy: true };
  });
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.deliveredTo, '@bob');
    assert.equal(out.deliveryWarning, undefined);
  }
  assert.deepEqual(sent, {
    to: bob.pubkeyHex,
    tipId: TIP_ID,
    claimKey: 'claimKeyClaimKeyClaimKeyClaimKey01234',
    asset: 'xmr',
    amount: 1_000_000,
    memo: 'thanks',
    expiresAt: 1_900_000_000,
  });
});

test('delivery: a relay failure is a warning on a funded tip, never a failed tip', async () => {
  const out = await deliverPersonTipOutcome(funded, fields(), async () => {
    throw new Error('relay down');
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.deliveredTo, undefined);
    assert.match(out.deliveryWarning ?? '', /funded/);
    assert.match(out.deliveryWarning ?? '', /relay down/);
    assert.ok(out.shareUrl, 'the link stays available as the fallback');
  }
});

test('delivery: no claim key or no deliverer still reports a funded tip', async () => {
  const noKey = await deliverPersonTipOutcome({ ...funded, shareUrl: null }, fields(), async () => ({ selfCopy: true }));
  assert.equal(noKey.ok, true);
  if (noKey.ok) assert.ok(noKey.deliveryWarning);
  const noDeliverer = await deliverPersonTipOutcome(funded, fields(), undefined);
  assert.equal(noDeliverer.ok, true);
  if (noDeliverer.ok) assert.ok(noDeliverer.deliveryWarning);
});

test('delivery: a link tip passes through untouched', async () => {
  const { recipient: _r, ...linkFields } = fields();
  const out = await deliverPersonTipOutcome(funded, linkFields as TipSubmitFields, async () => {
    throw new Error('must not deliver a link tip');
  });
  assert.deepEqual(out, funded);
});
