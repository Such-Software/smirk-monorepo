/**
 * Notes/feed plane tests. Locks in the three Phase-1 seams:
 *  - capability-driven posting gate (never a hardcoded paywall);
 *  - the relay-set seam (operator relay today, public fallback later);
 *  - kind-1 build/sign round-trips and display-projection rejects junk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveNostrIdentity } from '../identity';
import {
  NOTE_KIND,
  buildNoteEvent,
  toDisplayNote,
  postingRequirement,
  resolvePublishRelays,
  feedFilters,
} from '../notes';

const MNEMONIC =
  'leader monkey parrot ring guide accident before fence cannon height naive bean';
const identity = deriveNostrIdentity(MNEMONIC, 0);
const RELAY = 'wss://relay.smirk.cash';

test('postingRequirement never hardcodes a paywall — it reads operator policy', () => {
  // Open relay: always allowed.
  assert.equal(
    postingRequirement({ relayUrl: RELAY, writePolicy: 'open', hasPremium: false }).kind,
    'allowed',
  );
  // premium-post + no premium: blocked (buy-flow).
  assert.equal(
    postingRequirement({ relayUrl: RELAY, writePolicy: 'premium-post', hasPremium: false }).kind,
    'needs-premium',
  );
  // premium-post + premium held: allowed.
  assert.equal(
    postingRequirement({ relayUrl: RELAY, writePolicy: 'premium-post', hasPremium: true }).kind,
    'allowed',
  );
  // Non-premium policies never block.
  for (const writePolicy of ['inbox-outbox', 'author-allowlist']) {
    assert.equal(
      postingRequirement({ relayUrl: RELAY, writePolicy, hasPremium: false }).kind,
      'allowed',
      writePolicy,
    );
  }
  // No relay configured.
  assert.equal(postingRequirement({ hasPremium: true }).kind, 'no-relay');
});

test('resolvePublishRelays is operator-relay-only by default, fallback-extensible', () => {
  assert.deepEqual(resolvePublishRelays(RELAY), [RELAY]);
  assert.deepEqual(resolvePublishRelays(undefined), []);
  // Public fallback folds in (deduped), for the later opt-in.
  assert.deepEqual(
    resolvePublishRelays(RELAY, { publicFallback: ['wss://nos.lol', RELAY] }),
    [RELAY, 'wss://nos.lol'],
  );
});

test('buildNoteEvent signs a kind-1 that round-trips through toDisplayNote', () => {
  const evt = buildNoteEvent('gm nostr', identity, [['t', 'smirk']]);
  assert.equal(evt.kind, NOTE_KIND);
  assert.equal(evt.pubkey, identity.pubkeyHex);
  assert.equal(evt.content, 'gm nostr');
  assert.ok(evt.sig && evt.id, 'must be signed');

  const note = toDisplayNote(evt);
  assert.ok(note, 'valid note projects');
  assert.equal(note!.content, 'gm nostr');
  assert.equal(note!.pubkeyHex, identity.pubkeyHex);
  assert.ok(note!.npub.startsWith('npub1'));
  assert.deepEqual(note!.tags, [['t', 'smirk']]);
});

test('toDisplayNote rejects a tampered or wrong-kind event', () => {
  // JSON round-trip = how a wire event actually arrives (plain object, no cached
  // verify flag), so a tamper genuinely re-fails the signature check.
  const evt = JSON.parse(JSON.stringify(buildNoteEvent('original', identity)));
  // Tampered content -> signature no longer verifies -> rejected.
  assert.equal(toDisplayNote({ ...evt, content: 'forged' }), null);
  // Wrong kind -> rejected before signature check.
  assert.equal(toDisplayNote({ ...evt, kind: 7 }), null);
});

test('feedFilters builds author + hashtag filters from operator sources', () => {
  const filters = feedFilters(
    { authors: ['abc'], hashtags: ['bitcoin', 'nostr'] },
    50,
  );
  assert.equal(filters.length, 2);
  assert.deepEqual(filters[0], { kinds: [NOTE_KIND], authors: ['abc'], limit: 50 });
  assert.deepEqual(filters[1], { kinds: [NOTE_KIND], '#t': ['bitcoin', 'nostr'], limit: 50 });
  // Empty sources -> no filters (nothing to subscribe).
  assert.deepEqual(feedFilters({}), []);
});
