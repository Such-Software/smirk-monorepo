/**
 * Unit checks for the area D live-lane rules: relay admission, the footage
 * label and canary rules, the hold policy, and the live-spec static check.
 * No browser, no network, no secrets (the phrase below is made up).
 *
 *   node --test --import tsx packages/e2e/scripts/D-messaging-federation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRelayAdmits, LIVE_RELAY_WALLET_KINDS } from '../fixtures/relay-guard.ts';
import {
  D_HOLD,
  SecretCanary,
  assertStaticLabel,
  holdsShortened,
} from '../fixtures/D-messaging-federation-footage.ts';
import { check } from './D-messaging-federation-check-live-specs.mjs';

const PROD = 'wss://relay.smirk.cash';
const LOCAL = 'ws://127.0.0.1:8088';
const live = { E2E_LIVE_RELAY: '1' };

test('a local relay admits every kind, with or without the live flag', () => {
  for (const kind of [1, 1059, 10050, 30023]) assert.equal(liveRelayAdmits(LOCAL, kind, { env: {} }).admit, true);
});

test('a production relay refuses everything without E2E_LIVE_RELAY=1', () => {
  for (const kind of [1, 1059, 10050]) {
    const decision = liveRelayAdmits(PROD, kind, { env: {} });
    assert.equal(decision.admit, false);
    assert.ok(decision.reason.includes('E2E_LIVE_RELAY'), 'the refusal names the flag that would admit it');
  }
});

test('the live flag admits exactly the wallet kinds 1059 and 10050', () => {
  assert.deepEqual([...LIVE_RELAY_WALLET_KINDS], [1059, 10050]);
  for (const kind of LIVE_RELAY_WALLET_KINDS) assert.equal(liveRelayAdmits(PROD, kind, { env: live }).admit, true);
  for (const kind of [0, 3, 4, 5, 7, 10000, 30023]) assert.equal(liveRelayAdmits(PROD, kind, { env: live }).admit, false);
});

test('a public note needs premium AND owner approval', () => {
  assert.equal(liveRelayAdmits(PROD, 1, { env: live }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: live, premium: true }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: { ...live, E2E_LIVE_FEED_POST: '1' } }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: { ...live, E2E_LIVE_FEED_POST: '1' }, premium: true }).admit, true);
});

test('an unparseable or plain-ws public relay is production', () => {
  assert.equal(liveRelayAdmits('not a url', 1059, { env: {} }).admit, false);
  assert.equal(liveRelayAdmits('ws://relay.example.com', 1059, { env: {} }).admit, false);
  assert.equal(liveRelayAdmits(undefined, 1059, { env: live }).admit, false);
});

test('the hold policy is 6, 12 and 25 seconds', () => {
  assert.equal(D_HOLD.BEFORE_TAP_MS, 6_000);
  assert.equal(D_HOLD.SETTLED_MS, 12_000);
  assert.equal(D_HOLD.RESULT_MS, 25_000);
});

test('shortened holds are refused while recording', () => {
  assert.equal(holdsShortened({ E2E_LIVE_HOLDS: 'short' }), true);
  assert.throws(() => holdsShortened({ E2E_LIVE_HOLDS: 'short', FOOTAGE: 'guarded' }));
  assert.equal(holdsShortened({ FOOTAGE: 'guarded' }), false);
});

test('footage labels are static prose, never values', () => {
  for (const ok of ['send the message', 'Reply bob to alice', 'Federation: B survives a reload', 'open the inbox tab']) {
    assert.doesNotThrow(() => assertStaticLabel(ok));
  }
  for (const bad of ['npub1qqqqqq', 'https://api.smirk.cash', 'carol@smirk.cash', 'sent 1234567', '', 'x'.repeat(90)]) {
    assert.throws(() => assertStaticLabel(bad));
  }
});

test('the canary catches three phrase words in order and exact secrets, nothing else', () => {
  const canary = new SecretCanary();
  canary.addPhrase(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
  canary.addExact('correct-horse-battery');
  assert.equal(canary.hit(['words: Charlie  DELTA echo on screen']), true);
  assert.equal(canary.hit(['bravo charlie only']), false);
  assert.equal(canary.hit(['delta charlie bravo']), false);
  assert.equal(canary.hit(['the value correct-horse-battery leaked']), true);
  assert.equal(canary.hit(['Messages', 'npub1abc', '']), false);
});

test('the live-spec check refuses direct taps, ad hoc pauses and built labels', () => {
  const lines = (src) => check(src).map((v) => v.line);
  assert.deepEqual(lines("await page.getByTestId('x').click();"), [1]);
  assert.deepEqual(lines("await locator.fill('a');"), [1]);
  assert.deepEqual(lines('await page.waitForTimeout(500);'), [1]);
  assert.deepEqual(lines('dWallets.chapter(`DM ${x}`);'), [1]);
  assert.deepEqual(lines("await w.footage.tap(btn, `tap ${x}`);"), [1]);
  assert.deepEqual(lines("await w.footage.tap(btn, 'send the message');"), []);
  assert.deepEqual(lines("await w.footage.type(input, text, 'write the message');"), []);
  assert.deepEqual(lines('test.setTimeout(60_000);'), []);
  assert.deepEqual(lines(' * a comment that mentions .click( is fine'), []);
});
