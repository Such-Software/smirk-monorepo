/**
 * Federation display rule (petname > home > foreign name·domain > short npub) and
 * the "unverified names never render as names" safety property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatNostrAuthority, shortNpub } from '../authority';

const NPUB = 'npub1qqqqqqqqwxyzabcdefghijklmnop';

test('shortNpub truncates the middle', () => {
  assert.equal(shortNpub(NPUB), 'npub1qqqq…mnop');
  assert.equal(shortNpub('npub1short'), 'npub1short'); // too short to truncate
});

test('petname wins over everything', () => {
  const d = formatNostrAuthority({ npub: NPUB, nip05: 'alice@smirk.cash', verified: true, petname: 'Mom' });
  assert.equal(d.label, 'Mom');
  assert.equal(d.verified, true);
});

test('verified home name shows bare + check', () => {
  const d = formatNostrAuthority({ npub: NPUB, nip05: 'alice@smirk.cash', verified: true });
  assert.equal(d.label, 'alice');
  assert.equal(d.verified, true);
});

test('verified foreign name shows name·domain + check (federation)', () => {
  const d = formatNostrAuthority({ npub: NPUB, nip05: 'alice@goblin.st', verified: true });
  assert.equal(d.label, 'alice·goblin.st');
  assert.equal(d.verified, true);
});

test('an UNVERIFIED name is NOT rendered as a name — falls through to the npub', () => {
  const d = formatNostrAuthority({ npub: NPUB, nip05: 'alice@goblin.st', verified: false });
  assert.equal(d.label, shortNpub(NPUB)); // spoof-resistant
  assert.equal(d.verified, false);
});

test('no name at all → short npub, no check', () => {
  const d = formatNostrAuthority({ npub: NPUB });
  assert.equal(d.label, shortNpub(NPUB));
  assert.equal(d.verified, false);
});

test('homeDomain is configurable (self-hosted instance)', () => {
  const d = formatNostrAuthority({ npub: NPUB, nip05: 'alice@my.instance', verified: true, homeDomain: 'my.instance' });
  assert.equal(d.label, 'alice'); // bare, because it's THIS instance's authority
});
