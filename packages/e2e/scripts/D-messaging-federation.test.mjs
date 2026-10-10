/**
 * Unit checks for the area D live-lane rules: relay admission, the footage
 * label and canary rules, the hold policy, and the live-spec static check.
 * No browser, no network, no secrets (the phrase below is made up).
 *
 *   node --test --import tsx packages/e2e/scripts/D-messaging-federation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRelayAdmits, relayKey, LIVE_RELAY_WALLET_KINDS } from '../fixtures/relay-guard.ts';
import {
  D_HOLD,
  SecretCanary,
  assertStaticLabel,
  holdsShortened,
} from '../fixtures/D-messaging-federation-footage.ts';
import { check, checkHelper } from './D-messaging-federation-check-live-specs.mjs';

const PROD = 'wss://relay.smirk.cash';
const LOCAL = 'ws://127.0.0.1:8088';
const live = { E2E_LIVE_RELAY: '1' };
const pinned = [PROD];

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

test('the live flag admits exactly the wallet kinds 1059 and 10050 to a pinned relay', () => {
  assert.deepEqual([...LIVE_RELAY_WALLET_KINDS], [1059, 10050]);
  for (const kind of LIVE_RELAY_WALLET_KINDS) assert.equal(liveRelayAdmits(PROD, kind, { env: live, pinned }).admit, true);
  for (const kind of [0, 3, 4, 5, 7, 10000, 30023]) assert.equal(liveRelayAdmits(PROD, kind, { env: live, pinned }).admit, false);
});

test('a production relay that is not pinned is refused whatever the kind', () => {
  for (const kind of [1059, 10050]) {
    assert.equal(liveRelayAdmits(PROD, kind, { env: live }).admit, false, 'no pin list refuses');
    assert.equal(liveRelayAdmits(PROD, kind, { env: live, pinned: [] }).admit, false, 'an empty pin list refuses');
    const third = liveRelayAdmits('wss://relay.damus.io', kind, { env: live, pinned });
    assert.equal(third.admit, false, 'a third-party inbox relay is refused');
    assert.ok(!third.admit && third.reason.includes('pinned'), 'the refusal names the pin');
  }
  // Same host, other path or a trailing slash: the same relay.
  assert.equal(liveRelayAdmits(`${PROD}/`, 1059, { env: live, pinned }).admit, true);
  // Same host over plain ws, or another port: not the pinned relay.
  assert.equal(liveRelayAdmits('ws://relay.smirk.cash', 1059, { env: live, pinned }).admit, false);
  assert.equal(liveRelayAdmits('wss://relay.smirk.cash:8443', 1059, { env: live, pinned }).admit, false);
  // A second pinned relay (an approved backend B) is admitted alongside.
  assert.equal(liveRelayAdmits('wss://relay.b.example', 1059, { env: live, pinned: [PROD, 'wss://relay.b.example'] }).admit, true);
});

test('relayKey normalises ws and wss URLs and rejects anything else', () => {
  assert.equal(relayKey('wss://Relay.Smirk.Cash/'), 'wss://relay.smirk.cash');
  assert.equal(relayKey('ws://127.0.0.1:8088'), 'ws://127.0.0.1:8088');
  for (const bad of ['https://relay.smirk.cash', 'not a url', '', undefined]) assert.equal(relayKey(bad), null);
});

test('a public note needs premium AND owner approval', () => {
  assert.equal(liveRelayAdmits(PROD, 1, { env: live, pinned }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: live, pinned, premium: true }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: { ...live, E2E_LIVE_FEED_POST: '1' }, pinned }).admit, false);
  assert.equal(liveRelayAdmits(PROD, 1, { env: { ...live, E2E_LIVE_FEED_POST: '1' }, pinned, premium: true }).admit, true);
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

test('the helper check refuses fixed sleeps on the page clock, not polls or backoffs', () => {
  const lines = (src) => checkHelper(src).map((v) => v.line);
  assert.deepEqual(lines('await w.page.waitForTimeout(3_000);'), [1]);
  assert.deepEqual(lines('await page.waitForTimeout(limited ? 60_000 : 5_000);'), [1]);
  assert.deepEqual(lines('console.log(text);'), [1]);
  assert.deepEqual(lines('await retryBackoff(60_000);'), []);
  assert.deepEqual(lines('await new Promise((resolve) => setTimeout(resolve, 250));'), []);
  assert.deepEqual(lines('await submit.click();'), []);
  assert.deepEqual(lines(' * a comment that mentions waitForTimeout( is fine'), []);
});
