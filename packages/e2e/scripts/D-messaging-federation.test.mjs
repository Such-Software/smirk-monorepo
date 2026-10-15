/**
 * Unit checks for the area D live-lane rules: relay admission, the footage
 * label and canary rules, the hold policy, and the live-spec static check.
 * No browser, no network, no secrets (the phrase below is made up).
 *
 *   node --test --import tsx packages/e2e/scripts/D-messaging-federation.test.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { liveRelayAdmits, relayKey, LIVE_RELAY_WALLET_KINDS } from '../fixtures/relay-guard.ts';
import {
  D_HOLD,
  SecretCanary,
  assertStaticLabel,
  holdsShortened,
} from '../fixtures/D-messaging-federation-footage.ts';
import { check, checkHelper } from './D-messaging-federation-check-live-specs.mjs';
import { liveWrapSubscription, wrapSubscriptionTracker } from '../fixtures/D-messaging-federation-subscriptions.ts';
import { expectMessagingAs, shortNpub } from '../fixtures/D-messaging-federation-flows.ts';
import { hexToNpub } from '../fixtures/D-messaging-federation-nostr.ts';

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

test('only a gift-wrap subscription that stays open counts as a screen listening, not the tip poll on the same socket', () => {
  // 2026-10-14: the popup's tip poll and Messages share one pooled socket and
  // send the same filter; the tip poll's querySync closes at EOSE.
  const CAROL = 'c'.repeat(64);
  const log = [];
  const relayB = wrapSubscriptionTracker(log, '127.0.0.1:8089');
  const t0 = 1_000_000;
  const want = { host: '127.0.0.1:8089', p: CAROL, since: t0 };
  // A tip poll every 30 s, each closed within a second.
  for (let i = 0; i < 3; i++) {
    relayB.req(`poll${i}`, [CAROL], t0 + i * 30_000);
    relayB.close(`poll${i}`, t0 + i * 30_000 + 400);
  }
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 75_000 }), false, 'tip polls alone never pass');
  // Messages subscribes and keeps it open.
  relayB.req('messages', [CAROL], t0 + 80_000);
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 81_000 }), false, 'too young to tell from an in-flight query');
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 95_000 }), true, 'an open subscription held past the query window counts');
  // Not for another key, another relay, or one opened before the mark.
  assert.equal(liveWrapSubscription(log, { ...want, p: 'd'.repeat(64), now: t0 + 95_000 }), false);
  assert.equal(liveWrapSubscription(log, { ...want, host: 'relay.smirk.cash', now: t0 + 95_000 }), false);
  assert.equal(liveWrapSubscription(log, { ...want, since: t0 + 85_000, now: t0 + 95_000 }), false);
  // Closed, or replaced by a REQ reusing its id: no longer live.
  relayB.close('messages', t0 + 96_000);
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 120_000 }), false);
  relayB.req('again', [CAROL], t0 + 130_000);
  relayB.req('again', ['e'.repeat(64)], t0 + 131_000);
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 150_000 }), false, 'a replaced subscription is closed');
  // A CLOSE on another socket's id does not end this socket's subscription.
  const other = wrapSubscriptionTracker(log, 'relay.smirk.cash');
  relayB.req('shared-id', [CAROL], t0 + 200_000);
  other.close('shared-id', t0 + 201_000);
  assert.equal(liveWrapSubscription(log, { ...want, now: t0 + 215_000 }), true);
});

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

/**
 * A stand-in Messages screen with IdentityPicker's trigger rules: with one
 * identity and no manage entry the trigger is disabled and opens nothing;
 * with more it toggles a listbox whose selected option is the active npub.
 */
async function messagesScreen(npub, { identities }) {
  const page = await browser.newPage();
  const label = shortNpub(npub);
  await page.setContent(`<!doctype html><body>
    <button data-testid="messages-identity-picker" aria-haspopup="listbox" aria-expanded="false" ${identities > 1 ? '' : 'disabled'}>Messaging as ${label}</button>
    <div id="list"></div>
    <script>
      const trigger = document.querySelector('[data-testid=messages-identity-picker]');
      trigger.addEventListener('click', () => {
        const list = document.getElementById('list');
        const open = trigger.getAttribute('aria-expanded') !== 'true';
        trigger.setAttribute('aria-expanded', String(open));
        list.innerHTML = open ? '<div role="listbox"><div role="option" aria-selected="true">${label}</div><div role="option" aria-selected="false">npub1other…zzzz</div></div>' : '';
      });
    </script></body>`);
  const taps = [];
  const wallet = {
    page,
    relayGuard: { wrapSubscriptions: [{ p: [HEX], host: 'relay.smirk.cash', at: Date.now() }] },
    footage: {
      tap: async (target, label) => {
        taps.push(label);
        await target.click({ timeout: 2_000 });
      },
      settled: async () => undefined,
    },
  };
  return { page, wallet, taps };
}
const HEX = 'ab'.repeat(32);

test('Messages with one identity shows it on a picker that offers no list, and never taps it', async () => {
  // On 2026-10-14 d-messaging :177 clicked the disabled trigger and waited out the action timeout.
  const npub = hexToNpub(HEX);
  const { page, wallet, taps } = await messagesScreen(npub, { identities: 1 });
  await expectMessagingAs(wallet, npub, 0);
  assert.deepEqual(taps, [], 'a disabled picker is not tapped');
  await page.close();
});

test('Messages with several identities opens the picker and finds the npub selected', async () => {
  const npub = hexToNpub(HEX);
  const { page, wallet, taps } = await messagesScreen(npub, { identities: 2 });
  await expectMessagingAs(wallet, npub, 0);
  assert.equal(taps.length, 2, `opened and closed: ${taps.join(', ')}`);
  assert.equal(await page.getByRole('listbox').count(), 0, 'the picker is closed again');
  await page.close();
});
