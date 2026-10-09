/**
 * A tip whose claim was sent and proven but not yet confirmed by the network
 * reads "Claim sent, confirming", never as an error and never with a second
 * Claim button. That is how an XMR/WOW claim an older wallet reported by txid
 * alone looks once this wallet proved it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { render } from 'preact-render-to-string';

import { InboxTab, type InboxTipItem } from '../InboxTab';

const tip: InboxTipItem = {
  tipId: 'tip-1',
  assetId: 'wow',
  amountAtomic: 300_000_000_000n,
  senderDisplay: null,
  fundingConfirmations: 4,
  confirmationsRequired: 4,
  createdAt: '2026-10-08T00:00:00Z',
};

function inbox(tips: InboxTipItem[]): string {
  return render(
    h(InboxTab, {
      items: [],
      tips,
      onOpenIncomingSign: () => {},
      onOpenIncomingFinalize: () => {},
      onClaimTip: () => {},
    }),
  );
}

test('a claimable tip offers Claim', () => {
  const html = inbox([tip]);
  assert.match(html, /data-testid="tip-claim-btn"/);
  assert.doesNotMatch(html, /Claim sent, confirming/);
});

test('a tip whose claim is confirming says so and offers no second claim', () => {
  const html = inbox([{ ...tip, confirming: true }]);
  assert.match(html, /data-testid="tip-claim-confirming"/);
  assert.match(html, /Claim sent, confirming/);
  assert.doesNotMatch(html, /data-testid="tip-claim-btn"/);
  assert.doesNotMatch(html, /data-testid="tip-claim-error"/);
});
