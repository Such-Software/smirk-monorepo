/**
 * Money-tier session model (P4). The load-bearing property: money-tier kinds
 * (17/30402/22242) are NEVER session-covered and NEVER persisted into a session,
 * even if a stale or hostile session lists them. Low-tier kinds (1/7/1059) are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nostrKindTier,
  isNostrSessionActive,
  mergeNostrSession,
} from '../nostr-tiers';

test('nostrKindTier classifies money / session-grantable / default', () => {
  for (const k of [17, 30402, 22242]) assert.equal(nostrKindTier(k), 'money');
  for (const k of [1, 7, 1059]) assert.equal(nostrKindTier(k), 'session-grantable');
  for (const k of [0, 3, 30023, 42]) assert.equal(nostrKindTier(k), 'default');
});

test('isNostrSessionActive: covers a live low-tier kind', () => {
  const now = 1_000_000;
  const session = { kinds: [1, 7], expiresAt: now + 60_000 };
  assert.equal(isNostrSessionActive(session, 1, now), true);
  assert.equal(isNostrSessionActive(session, 7, now), true);
  assert.equal(isNostrSessionActive(session, 1059, now), false); // not in this session
  assert.equal(isNostrSessionActive(session, 1, now + 120_000), false); // expired
  assert.equal(isNostrSessionActive(undefined, 1, now), false);
});

test('isNostrSessionActive: a money-tier kind is NEVER covered, even if the session lists it', () => {
  const now = 1_000_000;
  // A hostile/buggy session that (wrongly) lists a money kind + is still live.
  const rogue = { kinds: [30402, 22242, 17], expiresAt: now + 60_000 };
  assert.equal(isNostrSessionActive(rogue, 30402, now), false);
  assert.equal(isNostrSessionActive(rogue, 22242, now), false);
  assert.equal(isNostrSessionActive(rogue, 17, now), false);
});

test('mergeNostrSession: drops money-tier + non-grantable kinds before persisting', () => {
  const now = 1_000_000;
  const merged = mergeNostrSession(undefined, { kinds: [1, 7, 30402, 22242, 30023], expiresAt: now + 60_000 }, now);
  assert.deepEqual(merged?.kinds.sort(), [1, 7]); // only session-grantable survive
  assert.equal(merged?.expiresAt, now + 60_000);
});

test('mergeNostrSession: unions with a still-live existing session; expired one is dropped', () => {
  const now = 1_000_000;
  const live = { kinds: [1], expiresAt: now + 30_000 };
  const merged = mergeNostrSession(live, { kinds: [7], expiresAt: now + 60_000 }, now);
  assert.deepEqual(merged?.kinds.sort(), [1, 7]);

  const expired = { kinds: [1059], expiresAt: now - 1 };
  const merged2 = mergeNostrSession(expired, { kinds: [7], expiresAt: now + 60_000 }, now);
  assert.deepEqual(merged2?.kinds, [7]); // expired kinds not carried forward
});

test('mergeNostrSession: an all-money grant yields no new session (keeps existing)', () => {
  const now = 1_000_000;
  assert.equal(mergeNostrSession(undefined, { kinds: [30402, 17], expiresAt: now + 60_000 }, now), undefined);
});
