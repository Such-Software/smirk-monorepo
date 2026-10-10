// The demo-capture guard must refuse every secret surface the tour could pass,
// and allow only the exact controls the lane documents. The live-lane verdict
// must card phrases and keys, mask passwords and claim links, and leave the
// welcome, lock, Settings and history screens recordable. Runs in real Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
  secretSurface, PRIVATE_TEXT,
  liveFrameVerdict, LIVE_RULES, LIVE_MASK_ATTRIBUTE, LIVE_CARD_CAPTIONS, createSecretCanary,
} from './guard.mjs';

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

// [name, html, value to type into the first field (or null), expected mode]
const claimLink = `https://smirk.cash/tip/9f3a1c#${randomBytes(18).toString('base64url')}`;
const liveCases = [
  ['the welcome screen',
    '<button data-testid="onboarding-create-btn">Create</button><button data-testid="onboarding-import-btn">Import</button><button data-testid="onboarding-choose-backend">Backend</button>',
    null, 'clean'],
  ['the lock screen',
    '<div data-testid="lockscreen-root"><input type="password" data-testid="lockscreen-password-input"><button data-testid="lockscreen-unlock-btn">Unlock</button></div>',
    null, 'mask'],
  ['a lock screen holding a typed password',
    '<input type="password" data-testid="lockscreen-password-input"><button data-testid="lockscreen-unlock-btn">Unlock</button>',
    'not-shown-anywhere', 'mask'],
  ['a password field shown as text by a toggle',
    '<input type="text" data-testid="onboarding-password-input">',
    'typed-in-plain-text', 'mask'],
  ['the Settings root with its reveal and policy controls',
    '<button data-testid="settings-reveal-btn">Reveal recovery phrase</button><input type="password" data-testid="settings-reveal-password"><label><input type="checkbox" data-testid="require-password-sends"> sends</label><label><input type="checkbox" data-testid="require-password-signing"> signing</label><button data-testid="settings-lock-now-btn">Lock</button><p data-testid="settings-build-identity">v0.3.1 (b615d73)</p>',
    null, 'mask'],
  ['the generated phrase grid', '<ol><li><span data-testid="onboarding-create-seed-word-0">word</span></li></ol>', null, 'card'],
  ['the verify challenge', '<input data-testid="onboarding-verify-word-7">', null, 'card'],
  ['the import word grid', '<input data-testid="onboarding-import-word-0">', null, 'card'],
  ['the revealed recovery phrase', '<p data-testid="settings-revealed-phrase">some words</p>', null, 'card'],
  ['a hidden phrase grid', '<span data-testid="onboarding-create-seed-word-0" style="display:none">word</span><p>ok</p>', null, 'clean'],
  ['an nsec in page text', '<p>nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'card'],
  ['an nsec split across text nodes', '<p><span>nsec1qqqqqqqqqq</span><span>qqqqqqqqqqqqqqqqqqqqqqqq</span></p>', null, 'card'],
  ['an xprv in page text', `<p>xprv${'9'.repeat(40)}</p>`, null, 'card'],
  ['a revealed nsec inside its masked element', `<div data-testid="nostr-nsec-${hex}">nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</div>`, null, 'mask'],
  ['the raw key export panel', '<div><span>XMR private spend key</span><code>00</code></div>', null, 'card'],
  ['a claim link in page text', `<p>Share this: ${claimLink}</p>`, null, 'mask'],
  ['a claim link pasted into the claim field', '<input data-testid="paste-tip-input">', claimLink, 'mask'],
  ['a claim link in an unnamed field', '<input>', claimLink, 'mask'],
  ['the tip share field', '<input data-testid="tip-share-url" value="x">', null, 'mask'],
  ['the empty claim paste field', '<input data-testid="paste-tip-input">', null, 'clean'],
  ['the empty nsec import field', '<input data-testid="nostr-import-nsec">', null, 'clean'],
  ['a filled nsec import field', '<input data-testid="nostr-import-nsec">', 'nsec1anything', 'mask'],
  ['a filled identity restore field', '<textarea data-testid="nostr-restore-input"></textarea>', '{"backup":1}', 'mask'],
  ['the tx key reveal control in its masked state', '<button data-testid="tx-detail-reveal-key">Show tx key</button>', null, 'clean'],
  ['a revealed tx key', '<span data-testid="tx-detail-tx-key">0123</span>', null, 'mask'],
  ['a swap provider private link', '<a data-testid="swap-status-private-link" href="#">open</a>', null, 'mask'],
  ['history with a txid', `<button>Received 0.1 WOW</button><span>${'c'.repeat(64)}</span>`, null, 'clean'],
  ['the identity hub controls', `<div data-testid="nostr-npub">npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</div><button data-testid="nostr-reveal-${hex}">key</button><button data-testid="nostr-export-backup">Export</button><div data-testid="nostr-unlock-prompt">Enter your password</div>`, null, 'clean'],
  ['the copy-phrase status line', '<button data-testid="onboarding-create-copy-seed">Copy phrase</button><span data-testid="onboarding-create-copy-seed-status">Copies the words only</span>', null, 'clean'],
  ['an admitted control id on a non-control', '<div data-testid="settings-reveal-btn">words</div>', null, 'card'],
  ['an unknown secret-bearing surface', '<div data-testid="wallet-backup-words">words</div>', null, 'card'],
];

const LABELS = new Set(['recovery phrase', 'private key text', 'raw private keys', 'protected surface',
  'password field', 'filled secret field', 'claim link', 'private key field', 'protected value']);

test('the live verdict cards phrases and keys, masks fields and links, and keeps ordinary screens', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, typed, mode] of liveCases) {
      await page.setContent(html);
      if (typed) await page.locator('input, textarea').first().fill(typed);
      const verdict = await page.evaluate(liveFrameVerdict, LIVE_RULES);
      assert.equal(verdict.mode, mode, `${name}: expected ${mode}, got ${verdict.mode} (${verdict.reasons.join(', ')})`);
      for (const reason of verdict.reasons) assert.ok(LABELS.has(reason), `${name}: reason is a rule label, not content`);
      if (typed) {
        const leaked = verdict.text.includes(typed) || (verdict.mode !== 'clean' && verdict.values.includes(typed));
        assert.equal(leaked, false, `${name}: a masked field's value reached the canary sample`);
      }
      // Every element the verdict masks must also be covered by a capture-time
      // selector or by the claim-link rule, which the recorder resolves again
      // when it takes the screenshot. (A claim link typed into an unnamed field
      // is covered by the verdict's own mask attribute, which the recorder also
      // passes; that is the one case CSS cannot express.)
      const uncovered = await page.evaluate(({ attribute, selectors, link }) => [...document.querySelectorAll(`[${attribute}]`)]
        .filter((element) => !element.matches(selectors.join(',')) && !new RegExp(link).test(element.textContent ?? '')
          && !new RegExp(link).test(element.value ?? ''))
        .map((element) => element.tagName), { attribute: LIVE_MASK_ATTRIBUTE, selectors: [...LIVE_RULES.maskSelectors], link: LIVE_RULES.claimLinkText });
      assert.deepEqual(uncovered, [], `${name}: a masked element has no capture-time selector`);
    }
  } finally {
    await browser.close();
  }
});

test('policy checkboxes stay visible while the password field beside them is masked', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent('<input type="checkbox" data-testid="require-password-sends"><input type="password" data-testid="operation-password">');
    const verdict = await page.evaluate(liveFrameVerdict, LIVE_RULES);
    assert.equal(verdict.masks, 1);
    const checkboxCovered = await page.evaluate((selectors) => document.querySelector('[data-testid="require-password-sends"]').matches(selectors.join(',')), [...LIVE_RULES.maskSelectors]);
    assert.equal(checkboxCovered, false);
  } finally {
    await browser.close();
  }
});

test('every card reason has a static caption', () => {
  for (const reason of ['recovery phrase', 'private key text', 'raw private keys', 'protected surface', 'known secret']) {
    assert.match(LIVE_CARD_CAPTIONS[reason] ?? '', /^[A-Z][a-z ]+$/);
  }
});

test('the canary finds known secrets in visible text and fields without keeping them', () => {
  const canary = createSecretCanary();
  const password = randomBytes(24).toString('base64url');
  const fragment = randomBytes(18).toString('base64url');
  const words = ['absorb', 'cactus', 'dwarf', 'echo', 'fabric', 'gallery', 'habit', 'icon', 'jaguar', 'kitten', 'ladder', 'magnet'];
  canary.addSecret(password);
  canary.addSecret(fragment);
  canary.addPhrase(words);

  assert.equal(canary.hit({ text: 'Balance 0.19 XMR', values: ['alice_handle'] }), false, 'ordinary text');
  assert.equal(canary.hit({ text: `Your password is ${password}.` }), true, 'a password in text');
  assert.equal(canary.hit({ values: [password] }), true, 'a password in a plain field');
  assert.equal(canary.hit({ text: `https://smirk.cash/tip/abc#${fragment}` }), true, 'a claim fragment in a link');
  assert.equal(canary.hit({ text: '01 dwarf 02 echo 03 fabric' }), true, 'three consecutive phrase words, numbered');
  assert.equal(canary.hit({ text: 'an echo of the gallery' }), false, 'single phrase words in ordinary prose');
  assert.equal(canary.hit({ text: 'echo dwarf fabric' }), false, 'phrase words out of order');
  assert.equal(JSON.stringify(canary).includes(password), false, 'the canary does not serialise its secrets');
  assert.equal(canary.size > 0, true);
});
