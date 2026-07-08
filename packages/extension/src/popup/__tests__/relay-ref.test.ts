/**
 * relay-ref codec (P3b): the routing token packed into an InboxItem's opaque
 * relayId so respond/cancel pick the right transport. Backend items are bare
 * slate_ids; Nostr items carry slate_id + counterparty pubkey.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeNostrRelayRef, parseRelayRef } from '../relay-ref';

const SLATE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PUB = 'ab'.repeat(32);

test('nostr ref round-trips slate_id + counterparty', () => {
  const ref = parseRelayRef(encodeNostrRelayRef(SLATE, PUB));
  assert.equal(ref.channel, 'nostr');
  assert.equal(ref.channel === 'nostr' && ref.slateId, SLATE);
  assert.equal(ref.channel === 'nostr' && ref.counterparty, PUB);
});

test('a bare slate_id parses as a backend ref (no nostr: prefix)', () => {
  const ref = parseRelayRef(SLATE);
  assert.equal(ref.channel, 'backend');
  assert.equal(ref.channel === 'backend' && ref.relayId, SLATE);
});

test('a malformed nostr ref (no separator) falls back to backend, not a crash', () => {
  const ref = parseRelayRef('nostr:justaslateid');
  // No second ":" → not a valid nostr ref → treated as a backend relayId verbatim.
  assert.equal(ref.channel, 'backend');
});
