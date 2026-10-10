// The B lane's frame guard: the reviewed demo guard plus exactly the history
// sheet's masked transaction-key state. Runs in real Chromium.
//   node --test packages/e2e/fixtures/B-send-receive-history-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { secretSurface, extraSecretSurface, canarySnapshot, B_PATTERNS, B_EXTRA, MASK_SELECTORS } from './B-send-receive-history-guard.mjs';

const txid = 'c0ffee'.repeat(10) + 'abcd';
const sheet = (inner) => `<div data-testid="tx-detail-sheet"><dl>
  <div><dt>Direction</dt><dd><span>Sent</span></dd></div>
  <div><dt>Transaction ID</dt><dd><span>${txid}</span></dd></div>
  ${inner}</dl></div>`;

const cases = [
  ['a history detail sheet without a key action', sheet(''), null, false],
  ['the masked tx key state: the Show button only', sheet('<button data-testid="tx-detail-reveal-key">Show transaction key</button><button data-testid="tx-detail-explorer">View in block explorer</button>'), null, false],
  ['the revealed tx key', sheet('<dt>Transaction key (secret)</dt><dd><span data-testid="tx-detail-tx-key">aa</span></dd>'), null, true],
  ['the revealed key label without the test id', sheet('<dt>Transaction key (secret)</dt><dd><span>aa</span></dd>'), null, true],
  ['the reveal test id on a non-button', '<div data-testid="tx-detail-reveal-key">Show</div>', null, true],
  ['the Settings phrase reveal control stays refused', '<button data-testid="settings-reveal-btn">Show</button>', null, true],
  ['a lock screen password field', '<input type="password" data-testid="lockscreen-password-input">', null, true],
  ['the operation password prompt', '<input type="password" data-testid="operation-password">', null, true],
  ['a tip share link element', '<div data-testid="tip-share-url">x</div>', null, true],
  ['a tip claim link in text', '<p>https://smirk.cash/tip/1a2b3c4d#k3yFragmentAbcdef</p>', null, true],
  ['an nsec display', '<div data-testid="nostr-nsec-ab">x</div>', null, true],
  ['a phrase entry field', '<input data-testid="onboarding-import-word-0">', null, true],
  ['a receive address', '<div data-testid="receive-address">bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4</div>', null, false],
  ['a slatepack paste field with content', '<textarea data-testid="paste-dispatch-input"></textarea>', 'BEGINSLATEPACK. x. ENDSLATEPACK.', false],
];

const verdict = async (page) => (await page.evaluate(secretSurface, B_PATTERNS)) ?? (await page.evaluate(extraSecretSurface, B_EXTRA));

test('the B guard refuses secret surfaces and admits only the masked tx key state', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, refused] of cases) {
      await page.setContent(html);
      if (fill) await page.fill('textarea, input', fill);
      const found = await verdict(page);
      assert.equal(Boolean(found), refused, `${name}: expected ${refused ? 'refusal' : 'admission'}, got ${found ?? 'clean'}`);
    }
  } finally {
    await browser.close();
  }
});

test('masks cover every password field and the paste fields', () => {
  for (const selector of ['input[type="password"]', '[data-testid="tx-detail-tx-key"]', '[data-testid="paste-tip-input"]', '[data-testid="paste-dispatch-input"]']) {
    assert.ok(MASK_SELECTORS.includes(selector), `${selector} is masked`);
  }
});

test('the canary snapshot reports field values without the guard printing them', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>visible</p><input data-testid="send-amount-input">');
    await page.fill('input', '0.5');
    const snap = await page.evaluate(canarySnapshot);
    assert.ok(snap.text.includes('visible'));
    assert.deepEqual(snap.values, ['0.5']);
  } finally {
    await browser.close();
  }
});
