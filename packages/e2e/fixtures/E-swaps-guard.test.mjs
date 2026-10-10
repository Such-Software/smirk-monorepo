// The E-swaps frame guard: each rule, in real Chromium, plus the canary.
// Run: node --test packages/e2e/fixtures/E-swaps-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { CARD_PATTERNS, Canary, MASK_SELECTORS, assertStaticLabel, frameSurface } from './E-swaps-guard.mjs';

const hex = 'ab'.repeat(32);
// [name, html, value typed into the first input or null, expected card or null, expected masked ids]
const cases = [
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, null, []],
  ['a swap quote', '<div data-testid="swap-quote-fee">≈ 0.0043 LTC, included in the estimate</div>', null, null, []],
  ['a bare password field is masked', '<input type="password">', 'hunter2hunter2', null, ['input']],
  ['the lock screen password is masked', '<div data-testid="lockscreen-root"><input type="password" data-testid="lockscreen-password-input"></div>', null, null, ['lockscreen-password-input']],
  ['the operation password is masked', '<input type="password" data-testid="operation-password">', null, null, ['operation-password']],
  ['a hidden password field needs no mask', '<input type="password" style="display:none"><p>ok</p>', null, null, []],
  ['the tx key is masked', `<span data-testid="tx-detail-tx-key">${hex}</span>`, null, null, ['tx-detail-tx-key']],
  ['the tip share url is masked', '<div data-testid="tip-share-url">x</div>', null, null, ['tip-share-url']],
  ['a pasted tip is masked', '<input data-testid="paste-tip-input">', 'anything', null, ['paste-tip-input']],
  ['an nsec display is masked', '<span data-testid="nostr-nsec-value">x</span>', null, null, ['nostr-nsec-value']],
  ['the nsec import field is masked', '<input data-testid="nostr-import-nsec">', null, null, ['nostr-import-nsec']],
  ['a phrase entry field is a card', '<input data-testid="onboarding-import-word-0">', null, 'recovery phrase', []],
  ['a generated phrase word is a card', '<span data-testid="onboarding-create-seed-word-3">word</span>', null, 'recovery phrase', []],
  ['a phrase verification field is a card', '<input data-testid="onboarding-verify-word-1">', null, 'recovery phrase', []],
  ['a revealed phrase is a card', '<div data-testid="settings-revealed-phrase">x</div>', null, 'recovery phrase', []],
  ['an nsec in page text is a card', '<p>nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'private key text', []],
  ['an xprv in page text is a card', '<p>xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi</p>', null, 'private key text', []],
  ['an nsec typed into a plain field is a card', '<input data-testid="note">', 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'private key text', []],
  ['an npub is public', '<p>npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, null, []],
  ['a tip claim link is a card', '<p>https://smirk.cash/tip/abcd1234#Zm9vYmFyYmF6cXV4</p>', null, 'tip claim link', []],
  ['a tip page without a fragment is public', '<p>https://smirk.cash/tip/abcd1234</p>', null, null, []],
  // Now recordable: the lock screen, Settings root and the reveal buttons that only ASK.
  ['the reveal-key button only asks', '<button data-testid="tx-detail-reveal-key">Show transaction key</button>', null, null, []],
  ['the settings reveal button only asks', '<button data-testid="settings-reveal-btn">Show recovery phrase</button>', null, null, []],
  ['the swap status link shows no address', '<a data-testid="swap-status-private-link" href="https://nonlogs.io/s/secret-token-0123456789">Open on NonLogs</a>', null, null, []],
];

test('the frame guard masks, carding or admitting each surface as documented', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, card, masked] of cases) {
      await page.setContent(html);
      if (fill) await page.locator('input').first().fill(fill);
      const surface = await page.evaluate(frameSurface, { masks: MASK_SELECTORS, patterns: CARD_PATTERNS });
      assert.equal(surface.card, card, `${name}: card`);
      assert.deepEqual(surface.masked, masked, `${name}: masked`);
    }
  } finally {
    await browser.close();
  }
});

test('masked text and password values never reach the text the canary reads', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    const key = randomBytes(32).toString('hex');
    const password = randomBytes(24).toString('base64url');
    await page.setContent(`<p>Transaction key</p><span data-testid="tx-detail-tx-key">${key}</span><input type="password"><input data-testid="amount">`);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('[data-testid="amount"]').fill('0.5');
    const surface = await page.evaluate(frameSurface, { masks: MASK_SELECTORS, patterns: CARD_PATTERNS });
    assert.equal(surface.text.includes(key), false);
    assert.equal(surface.values.includes(password), false);
    assert.deepEqual(surface.values, ['0.5']);
    assert.match(surface.text, /Transaction key/);
    // The link's address is an attribute, not text.
    await page.setContent('<a href="https://nonlogs.io/s/secret-token-0123456789">Open on NonLogs</a>');
    const link = await page.evaluate(frameSurface, { masks: MASK_SELECTORS, patterns: CARD_PATTERNS });
    assert.equal(link.text.includes('secret-token'), false);
  } finally {
    await browser.close();
  }
});

test('the canary recognises a phrase run, a password and a bearer link, and nothing else', () => {
  const canary = new Canary();
  const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
  canary.addPhrase(words);
  const password = randomBytes(24).toString('base64url');
  canary.addLiteral(password);
  canary.addLiteral('https://nonlogs.io/swap/42?token=Zm9vYmFyYmF6cXV4cXV1eA', ['42']);
  assert.equal(canary.hit({ text: 'Able about above', values: [] }), true, 'three phrase words in order');
  assert.equal(canary.hit({ text: 'able about', values: [] }), false, 'two words are not a run');
  assert.equal(canary.hit({ text: 'about able above', values: [] }), false, 'out of order');
  assert.equal(canary.hit({ text: '', values: [password] }), true, 'the password in a field');
  assert.equal(canary.hit({ text: 'see Zm9vYmFyYmF6cXV4cXV1eA', values: [] }), true, 'the token alone');
  assert.equal(canary.hit({ text: 'Trade id 42', values: [] }), false, 'the public trade id');
  assert.equal(canary.hit({ text: 'Swap status: completed, 0.19 LTC sent', values: ['0.00015'] }), false);
  assert.throws(() => canary.addLiteral('short'));
  // The trade id is public on the status step, so it is never a canary tail.
  const quiet = new Canary();
  quiet.addLiteral('https://nonlogs.io/swap/abcdef0123456789abcdef', ['abcdef0123456789abcdef']);
  assert.equal(quiet.hit({ text: 'Trade id abcdef0123456789abcdef', values: [] }), false);
});

test('footage labels admit static words only', () => {
  assert.equal(assertStaticLabel('THORChain quote before confirming'), 'THORChain quote before confirming');
  assert.equal(assertStaticLabel("swap status: deposit confirming"), 'swap status: deposit confirming');
  for (const bad of ['bc1qjc86s9s508ttkryzsk35agghhv664a6an5eclv', 'https://x.y', 'txid 0123456789', 'tip #frag', '', 'a'.repeat(81)]) {
    assert.throws(() => assertStaticLabel(bad), undefined, bad);
  }
});
