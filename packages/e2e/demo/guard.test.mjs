// The demo-capture guard must refuse every secret surface the tour could pass,
// and allow only the exact controls the lane documents. Runs in real Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { secretSurface, PRIVATE_TEXT } from './guard.mjs';

const hex = 'ab'.repeat(32);
const cases = [
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, false],
  ['a password field', '<input type="password">', null, true],
  ['a hidden password field', '<input type="password" style="display:none"><p>ok</p>', null, false],
  ['a phrase entry field', '<div data-testid="onboarding-import-word-0">x</div>', null, true],
  ['a reveal-phrase control', '<button data-testid="settings-reveal-phrase">Show</button>', null, true],
  ['an nsec in page text', '<p>nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, true],
  ['an npub in page text', '<p>npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, false],
  ['the identity reveal button', `<button data-testid="nostr-reveal-${hex}">Reveal</button>`, null, false],
  ['the same id on a non-button', `<div data-testid="nostr-reveal-${hex}">secret</div>`, null, true],
  ['the empty nsec import field', '<input data-testid="nostr-import-nsec">', null, false],
  ['a filled nsec import field', '<input data-testid="nostr-import-nsec">', 'x', true],
  ['the settings reveal password field', '<input type="password" data-testid="settings-reveal-password">', null, true],
];

test('the demo guard refuses secret surfaces and admits only documented controls', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, refused] of cases) {
      await page.setContent(html);
      if (fill) await page.fill('input', fill);
      const found = await page.evaluate(secretSurface, PRIVATE_TEXT);
      assert.equal(Boolean(found), refused, `${name}: expected ${refused ? 'refusal' : 'admission'}, got ${found ?? 'clean'}`);
    }
  } finally {
    await browser.close();
  }
});
