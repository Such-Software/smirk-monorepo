// The C-tips capture guard and recorder, exercised in real Chromium on static
// pages (no wallet, no secrets): every rule's verdict, the canary, label policy,
// and a short recording that must mask, card, deduplicate and write private files.
//
//   node --import tsx --test packages/e2e/fixtures/C-tips-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { C_TIPS_RULES, assertStaticLabel, cTipsSurvey, findLeak } from './C-tips-guard.mjs';

const LINK = 'https://smirk.cash/tip/11111111-2222-4333-8444-555555555555#AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const surveys = [
  // [name, html, fill (selector, value) or null, expected: 'card' | number of masks, link visible in segments]
  ['a plain balance screen', '<div data-testid="home-total-balance">$1</div>', null, 0],
  ['the success screen link', `<div data-testid="tip-share-url">${LINK}</div>`, null, 1],
  ['the Sent tips link panel without a test id', `<div><div><div>${LINK}</div><button>Copy</button></div></div>`, null, 1],
  ['an empty paste box', '<textarea data-testid="paste-tip-input"></textarea>', null, 0],
  ['a filled paste box', '<textarea data-testid="paste-tip-input"></textarea>', ['textarea', LINK], 1],
  ['a revealed tx key', '<span data-testid="tx-detail-tx-key">00ff</span>', null, 1],
  ['a revealed nsec', `<div data-testid="nostr-nsec-${'ab'.repeat(32)}">x</div>`, null, 1],
  ['a password field', '<input type="password" data-testid="operation-password">', null, 1],
  ['a phrase entry word', '<div data-testid="onboarding-import-word-0">x</div>', null, 'card'],
  ['a created phrase word', '<div data-testid="onboarding-create-seed-word-3">x</div>', null, 'card'],
  ['the revealed phrase', '<div data-testid="settings-revealed-phrase">x</div>', null, 'card'],
  ['a hidden phrase word', '<div data-testid="onboarding-import-word-0" style="display:none">x</div>', null, 0],
];

test('the survey masks claim links and key material, and cards phrase surfaces', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, expected] of surveys) {
      await page.setContent(html);
      if (fill) await page.fill(fill[0], fill[1]);
      const survey = await page.evaluate(cTipsSurvey, C_TIPS_RULES);
      if (expected === 'card') {
        assert.equal(survey.card, 'phrase', `${name}: expected a card`);
        continue;
      }
      assert.equal(survey.card, null, `${name}: unexpected card`);
      assert.equal(survey.masked, expected, `${name}: mask count`);
      assert.equal(survey.segments.some((s) => s.includes('#AbCdEf')), false, `${name}: link left unmasked`);
      assert.equal(findLeak(survey.segments), null, `${name}: canary fired on a masked page`);
    }
  } finally {
    await browser.close();
  }
});

test('the canary names the leak kind for unmasked secrets and stays quiet otherwise', () => {
  assert.equal(findLeak(['Balance 0.19 XMR', 'Send a tip']), null);
  assert.match(findLeak([`look ${LINK}`]), /claim link/);
  assert.match(findLeak(['nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq']), /private key/);
  assert.match(findLeak(['value s3cret-value-x'], { exact: ['s3cret-value-x'] }), /registered secret/);
  const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
  assert.match(findLeak(['the words', 'ability able about'], { phraseWords: words }), /phrase/);
  assert.equal(findLeak(['about the ability'], { phraseWords: words }), null, 'two words in another order are not a leak');
  assert.equal(findLeak(['short'], { exact: ['short'] }), null, 'very short values are not registered');
  const leak = findLeak([`x ${LINK}`]);
  assert.equal(leak.includes('AbCdEf'), false, 'the label never carries the value');
});

test('footage labels are static descriptions, never values', () => {
  for (const ok of ['Claim', 'Tip details: claimed', 'BTC 3,000 sat link tip', "Open the inbox tab"]) {
    assert.equal(assertStaticLabel(ok), ok);
  }
  for (const bad of [LINK, 'npub1abcdefghij', 'tip 0123456789abcdef0123', 'a#b', '', 'x'.repeat(200)]) {
    assert.throws(() => assertStaticLabel(bad), undefined, `accepted: ${bad.slice(0, 20)}`);
  }
});

test('a short recording masks, cards on a registered secret, deduplicates, and writes private files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c-tips-footage-'));
  const saved = { FOOTAGE: process.env.FOOTAGE, FOOTAGE_DIR: process.env.FOOTAGE_DIR };
  process.env.FOOTAGE = 'guarded';
  process.env.FOOTAGE_DIR = root;
  const { GuardedFootage } = await import('./C-tips-footage.ts');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await page.setContent(`<body style="background:#222;color:#eee"><p>Tip link created</p><div data-testid="tip-share-url">${LINK}</div></body>`);
    const footage = new GuardedFootage();
    footage.attach('alice', page);
    await page.waitForTimeout(1_500);
    footage.registerSecret('registered-secret-value');
    await page.setContent('<body><p>registered-secret-value</p></body>');
    await page.waitForTimeout(1_500);
    await page.setContent('<body><div data-testid="onboarding-import-word-0">x</div></body>');
    await page.waitForTimeout(1_000);
    await footage.close();

    const dir = join(root, 'raw', 'C-tips');
    assert.equal(statSync(join(root, 'raw')).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'alice')).mode & 0o777, 0o700);
    const timeline = JSON.parse(readFileSync(join(dir, 'alice', 'timeline.json'), 'utf8'));
    const verdicts = timeline.frames.map((f) => f.verdict);
    assert.ok(verdicts.includes('masked'), 'the link screen was kept with a mask');
    assert.ok(verdicts.includes('card'), 'the registered secret and the phrase were carded');
    assert.equal(verdicts.includes('clean'), false, 'no frame of these screens is unmasked');
    assert.ok(timeline.frames.every((f) => f.to >= f.from), 'every frame has a time span');
    const files = readdirSync(join(dir, 'alice')).filter((f) => f.endsWith('.jpg'));
    assert.equal(files.length, timeline.frames.length, 'one file per distinct frame');
    // Static screens are stored once: far fewer files than capture ticks.
    assert.ok(files.length < 8, `deduplication kept ${files.length} files`);
    for (const file of files) assert.equal(statSync(join(dir, 'alice', file)).mode & 0o777, 0o600);
    for (const file of files) {
      assert.equal(readFileSync(join(dir, 'alice', file)).includes(Buffer.from('registered-secret-value')), false);
    }
    const lane = JSON.parse(readFileSync(join(dir, 'lane.json'), 'utf8'));
    assert.equal(lane.shortHolds, 0);
    assert.equal(JSON.stringify(lane).includes('registered-secret-value'), false);
    assert.equal(JSON.stringify(timeline).includes('AbCdEf'), false);
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
