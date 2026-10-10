// The F-legacy-recovery frame guard must redact every secret surface its live
// flows can pass, keep the recordable screens recordable, and the live spec
// must route every interaction through the footage helpers. Runs in real
// Chromium: node --test packages/e2e/fixtures/F-legacy-recovery-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { FRAME_GUARD_PATTERNS, classifyFrame, createCanary, canaryUnits } from './F-legacy-recovery-guard.mjs';

const hex = 'ab'.repeat(32);
// Generated per run: the canary is exercised with values no file holds.
const phrase = Array.from({ length: 12 }, () => randomBytes(6).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]));
const password = randomBytes(24).toString('base64url');
const fragment = randomBytes(32).toString('base64url');

const canary = createCanary();
canary.addPhrase(phrase);
canary.addToken(password);
canary.addToken(fragment);

// [name, html, fill, expected kind, expected reason (substring) or null]
const cases = [
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, 'clean', null],
  ['the older-address screen', '<div data-testid="legacy-funds-route"><button data-testid="legacy-check">Check</button><input type="checkbox" data-testid="legacy-auto-check"></div>', null, 'clean', null],
  ['an empty password field', '<input type="password">', null, 'mask', 'mask:password-field'],
  ['a hidden password field', '<input type="password" style="display:none"><p>ok</p>', null, 'clean', null],
  ['the lock screen', '<div data-testid="lockscreen-root"><input type="password" data-testid="lockscreen-password-input"><button data-testid="lockscreen-unlock-btn">Unlock</button></div>', null, 'mask', 'mask:password-field'],
  ['the Settings root reveal controls', '<input type="password" data-testid="settings-reveal-password"><button data-testid="settings-reveal-btn">Show</button>', null, 'mask', 'mask:password-field'],
  ['the operation password dialog', '<form><input type="password" data-testid="operation-password"><button data-testid="operation-password-confirm">Confirm</button></form>', null, 'mask', 'mask:password-field'],
  ['a phrase entry field', '<input data-testid="onboarding-import-word-0">', null, 'card', 'phrase-surface'],
  ['a created phrase word', '<span data-testid="onboarding-create-seed-word-3">word</span>', null, 'card', 'phrase-surface'],
  ['a phrase verification word', '<input data-testid="onboarding-verify-word-1">', null, 'card', 'phrase-surface'],
  ['a revealed phrase', '<p data-testid="settings-revealed-phrase">words</p>', null, 'card', 'phrase-surface'],
  ['the masked tx key control', '<button data-testid="tx-detail-reveal-key">Reveal</button>', null, 'clean', null],
  ['a revealed tx key', `<span data-testid="tx-detail-tx-key">${hex}</span>`, null, 'mask', 'mask:tx-key'],
  ['a tip share URL', '<div data-testid="tip-share-url">https://smirk.cash/tip/abc</div>', null, 'mask', 'mask:tip-share-url'],
  ['a claim link in page text', '<p>https://smirk.cash/tip/1234abcd#AbCdEfGh12345678</p>', null, 'mask', 'mask:claim-link'],
  ['a claim link split across elements', '<p><span>https://smirk.cash/tip/1234abcd</span><span>#AbCdEfGh12345678</span></p>', null, 'card', 'claim-link-unlocalised'],
  ['the paste-tip placeholder text', '<p>Paste a Smirk public-tip URL (smirk.cash/tip/…#…).</p>', null, 'clean', null],
  ['an empty claim-link input', '<textarea data-testid="paste-tip-input"></textarea>', null, 'clean', null],
  ['a filled claim-link input', '<textarea data-testid="paste-tip-input"></textarea>', 'https://smirk.cash/tip/x', 'mask', 'mask:claim-link-input'],
  ['an empty nsec import field', '<input data-testid="nostr-import-nsec">', null, 'clean', null],
  ['a filled nsec import field', '<input data-testid="nostr-import-nsec">', 'x', 'mask', 'mask:nsec-import-input'],
  ['an nsec in page text', '<p>nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'card', 'private-key-text'],
  ['an npub in page text', '<p>npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'clean', null],
  ['the identity reveal button', `<button data-testid="nostr-reveal-${hex}">Reveal</button>`, null, 'clean', null],
  ['three phrase words in page text', `<p>${phrase.slice(4, 7).join(' ')}</p>`, null, 'card', 'known-secret'],
  ['two phrase words in page text', `<p>${phrase.slice(4, 6).join(' ')} and more</p>`, null, 'clean', null],
  ['the password in a text input', '<input data-testid="note">', password, 'card', 'known-secret'],
  ['the password in a password input', '<input type="password">', password, 'mask', 'mask:password-field'],
  ['a claim fragment in page text', `<p>key ${fragment}</p>`, null, 'card', 'known-secret'],
];

test('the frame guard redacts secret surfaces and keeps recordable screens', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    // An https origin: WebCrypto needs a secure context, as extension pages are.
    await page.route('https://guard.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://guard.test/');
    for (const [name, html, fill, kind, reason] of cases) {
      await page.setContent(html);
      if (fill) await page.fill('input, textarea', fill);
      const verdict = await page.evaluate(classifyFrame, { patterns: FRAME_GUARD_PATTERNS, canary: canary.forPage() });
      assert.equal(verdict.kind, kind, `${name}: expected ${kind}, got ${verdict.kind} (${verdict.reasons.join(', ')})`);
      if (reason) assert.ok(verdict.reasons.includes(reason), `${name}: expected reason ${reason}, got ${verdict.reasons.join(', ')}`);
      // Reasons are labels, never content.
      for (const r of verdict.reasons) assert.match(r, /^[a-z:-]+$/, `${name}: reason carries content`);
    }
  } finally {
    await browser.close();
  }
});

test('the canary sends only a key and digests to the page', () => {
  const sent = JSON.stringify(canary.forPage());
  for (const secret of [password, fragment, ...phrase]) assert.ok(!sent.includes(secret), 'a secret reached the page payload');
  assert.ok(canary.size() >= 10 + 2, 'phrase windows and tokens were not all digested');
  assert.deepEqual(canaryUnits('a b'), []);
});

test('the live spec routes every interaction through the footage helpers', () => {
  const spec = readFileSync(new URL('../tests/live/f-legacy-recovery.live.spec.ts', import.meta.url), 'utf8');
  // Direct clicks, fills or sleeps would bypass the pre-tap pause, the guard
  // and the timeline. Holds live in the fixture, never in the spec.
  for (const banned of [/\.click\(/, /\.fill\(/, /\.type\(/, /\.press\(/, /waitForTimeout\(/, /(^|[^.\w])setTimeout\(/m, /console\.log\(/]) {
    assert.ok(!banned.test(spec), `the live spec calls ${banned.source} directly`);
  }
});
