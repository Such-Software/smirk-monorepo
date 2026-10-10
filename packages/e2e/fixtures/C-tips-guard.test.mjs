// The C-tips capture guard and recorder, exercised in real Chromium on static
// pages (no wallet, no secrets): every rule's verdict, the per-capture nonce,
// the canary, label policy, static-hold verification, and short recordings
// whose kept JPEGs are decoded and checked PIXEL BY PIXEL: every secret is drawn
// as a solid red block, so any red in a kept frame is a leak.
//
//   node --import tsx --test packages/e2e/fixtures/C-tips-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { C_TIPS_RULES, assertStaticLabel, cTipsSurvey, findLeak, maskSelectorFor } from './C-tips-guard.mjs';

const LINK = 'https://smirk.cash/tip/11111111-2222-4333-8444-555555555555#AbCdEfGhIjKlMnOpQrStUvWxYz012345';
/** A secret drawn so that any unmasked pixel of it is unmistakably red. */
const RED = 'background:#ff0000;color:#ff0000;font-size:28px;height:90px;width:340px;overflow:hidden';
/** Fast holds for tests only; the live lane always runs the owner policy. */
const TEST_POLICY = { tap: 300, settled: 600, result: 900 };

const surveys = [
  // [name, html, fill (selector, value) or null, expected: 'card' | number of masks]
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

const survey = (page, nonce, mode) => page.evaluate(cTipsSurvey, { rules: C_TIPS_RULES, nonce, mode });

/** Count strongly red pixels in a JPEG, decoded by the browser. */
async function redPixels(page, file) {
  const data = `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, img.width, img.height);
    let red = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 180 && px[i + 1] < 90 && px[i + 2] < 90) red++;
    return red;
  }, data);
}

/** Set up a recording into a fresh temp root; returns helpers and a cleanup. */
async function recording(t) {
  const root = mkdtempSync(join(tmpdir(), 'c-tips-footage-'));
  const saved = { FOOTAGE: process.env.FOOTAGE, FOOTAGE_DIR: process.env.FOOTAGE_DIR, C_TIPS_INVOCATION: process.env.C_TIPS_INVOCATION };
  process.env.FOOTAGE = 'guarded';
  process.env.FOOTAGE_DIR = root;
  process.env.C_TIPS_INVOCATION = 'offline-test';
  const { GuardedFootage } = await import('./C-tips-footage.ts');
  const browser = await chromium.launch({ channel: 'chromium' });
  t.after(async () => {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const sessionDir = (footage) => join(root, 'raw', 'C-tips', 'offline-test', footage.session);
  return { root, browser, GuardedFootage, sessionDir };
}

/** Every kept JPEG of one page, with its red-pixel count. */
async function keptFrames(browser, dir) {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
  const checker = await browser.newPage();
  const frames = [];
  for (const frame of timeline.frames) frames.push({ ...frame, red: await redPixels(checker, join(dir, frame.file)) });
  await checker.close();
  return { timeline, frames };
}

test('the survey masks claim links and key material, and cards phrase surfaces', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, expected] of surveys) {
      await page.setContent(html);
      if (fill) await page.fill(fill[0], fill[1]);
      const marked = await survey(page, 'aa11bb22cc33dd44', 'mark');
      if (expected === 'card') {
        assert.equal(marked.card, 'phrase', `${name}: expected a card`);
        continue;
      }
      assert.equal(marked.card, null, `${name}: unexpected card`);
      assert.equal(marked.masked, expected, `${name}: mask count`);
      assert.equal(marked.segments.some((s) => s.includes('#AbCdEf')), false, `${name}: link left unmasked`);
      assert.equal(findLeak(marked.segments), null, `${name}: canary fired on a masked page`);
      assert.equal(await page.locator(maskSelectorFor('aa11bb22cc33dd44')).count(), expected, `${name}: marks carry the nonce`);
      const verified = await survey(page, 'aa11bb22cc33dd44', 'verify');
      assert.equal(verified.unmarked, 0, `${name}: an unchanged page verifies`);
      assert.equal(verified.signature, marked.signature, `${name}: same mask geometry`);
    }
  } finally {
    await browser.close();
  }
});

test('a mask target re-created in place after marking fails verification, and scan never touches the page', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="holder"><div class="link">${LINK}</div></div>`);
    await survey(page, '0123456789abcdef', 'mark');
    // Same position, same size, same text: only the node is new.
    await page.evaluate(() => {
      const old = document.querySelector('.link');
      const fresh = old.cloneNode(true);
      fresh.removeAttribute('data-c-tips-mask');
      old.replaceWith(fresh);
    });
    const after = await survey(page, '0123456789abcdef', 'verify');
    assert.equal(after.unmarked, 1, 'the re-created node lacks this capture\'s nonce');
    await survey(page, null, 'scan');
    assert.equal(await page.locator('[data-c-tips-mask]').count(), 0, 'scan adds no marks');
    assert.throws(() => maskSelectorFor('not hex!'), 'a nonce is hex only');
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

test('a recording masks links, cards registered secrets and phrases, deduplicates, and no kept pixel is red', async (t) => {
  const { browser, GuardedFootage, sessionDir } = await recording(t);
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  await page.setContent(`<body style="background:#222;color:#eee"><p>Tip link created</p><div data-testid="tip-share-url" style="${RED}">${LINK}</div></body>`);
  const footage = new GuardedFootage({ policy: TEST_POLICY, staticPatienceMs: 5_000 });
  footage.attach('alice', page);
  await page.waitForTimeout(1_500);
  footage.registerSecret('registered-secret-value');
  await page.setContent(`<body style="background:#222"><p style="${RED}">registered-secret-value</p></body>`);
  await page.waitForTimeout(1_500);
  await page.setContent(`<body style="background:#222"><div data-testid="onboarding-import-word-0" style="${RED}">abandon</div></body>`);
  await page.waitForTimeout(1_000);
  const summary = await footage.close();

  const dir = sessionDir(footage);
  assert.equal(summary.dir, dir);
  for (const level of [join(dir, '..', '..', '..'), join(dir, '..', '..'), join(dir, '..'), dir, join(dir, 'alice')]) {
    assert.equal(statSync(level).mode & 0o777, 0o700, 'every footage directory is owner-only');
  }
  const { timeline, frames } = await keptFrames(browser, join(dir, 'alice'));
  const verdicts = frames.map((f) => f.verdict);
  assert.ok(verdicts.includes('masked'), 'the link screen was kept with a mask');
  assert.ok(verdicts.includes('card'), 'the registered secret and the phrase were carded');
  assert.equal(verdicts.includes('clean'), false, 'no frame of these screens is unmasked');
  for (const frame of frames) assert.equal(frame.red, 0, `kept frame ${frame.file} (${frame.verdict}) shows red secret pixels`);
  assert.ok(timeline.frames.every((f) => f.to >= f.from), 'every frame has a time span');
  const files = readdirSync(join(dir, 'alice')).filter((f) => f.endsWith('.jpg'));
  assert.equal(files.length, timeline.frames.length, 'one file per distinct frame');
  assert.ok(files.length < 8, `deduplication kept ${files.length} files`);
  for (const file of files) assert.equal(statSync(join(dir, 'alice', file)).mode & 0o777, 0o600);
  const lane = JSON.parse(readFileSync(join(dir, 'lane.json'), 'utf8'));
  assert.deepEqual(lane.policy, TEST_POLICY, 'the lane file records the policy it ran');
  assert.equal(JSON.stringify(lane).includes('registered-secret-value'), false);
  assert.equal(JSON.stringify(timeline).includes('AbCdEf'), false);
});

test('a claim link re-created in place every 30 ms is never kept unmasked (the nonce race)', async (t) => {
  const { browser, GuardedFootage, sessionDir } = await recording(t);
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  await page.setContent('<body style="background:#222;color:#eee;margin:0"><p>Sent tips</p><div id="slot"></div></body>');
  // The panel has no test id, so only its text marks it: re-create it constantly.
  await page.evaluate(([link, style]) => {
    const draw = () => {
      const block = document.createElement('div');
      block.setAttribute('style', style);
      block.textContent = link;
      document.getElementById('slot').replaceChildren(block);
    };
    draw();
    setInterval(draw, 30);
  }, [LINK, RED]);
  const footage = new GuardedFootage({ policy: TEST_POLICY, staticPatienceMs: 2_000 });
  footage.attach('carol', page);
  await page.waitForTimeout(6_000);
  await footage.close();
  const { timeline, frames } = await keptFrames(browser, join(sessionDir(footage), 'carol'));
  for (const frame of frames) assert.equal(frame.red, 0, `kept frame ${frame.file} (${frame.verdict}) shows the unmasked link`);
  assert.ok(timeline.dropped > 0, 'frames whose mask target was re-created were dropped');
});

test('a hold waits for a still recorded screen, restarts on change, and records a screen that never stops', async (t) => {
  const { browser, GuardedFootage, sessionDir } = await recording(t);
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  await page.setContent('<body style="background:#222;color:#eee"><p id="n">0</p></body>');
  const footage = new GuardedFootage({ policy: TEST_POLICY, staticPatienceMs: 3_000 });
  footage.attach('bob', page);

  // Still: the hold passes in about its policy time.
  await footage.result(page, 'Still screen');
  // Changing for 1.5 s, then still: the hold's window starts after the last change.
  await page.evaluate(() => {
    let n = 0;
    const id = setInterval(() => (document.getElementById('n').textContent = String(++n)), 150);
    setTimeout(() => clearInterval(id), 1_500);
  });
  const changedUntil = Date.now() + 1_500;
  await footage.settled(page, 'Screen that settles');
  // Never still: recorded as not static once the patience runs out.
  await page.evaluate(() => setInterval(() => (document.getElementById('n').textContent = String(Math.random())), 100));
  await footage.result(page, 'Screen that never stops');
  const summary = await footage.close();

  const lane = JSON.parse(readFileSync(join(sessionDir(footage), 'lane.json'), 'utf8'));
  const [still, settles, never] = lane.holds;
  assert.equal(still.static, true);
  assert.ok(still.to - still.from >= TEST_POLICY.result);
  assert.equal(settles.static, true);
  assert.ok(settles.from >= changedUntil - 400, 'the window started after the screen stopped changing');
  assert.ok(settles.to - settles.from >= TEST_POLICY.settled);
  assert.equal(never.static, false, 'a screen that never stops is not a hold');
  assert.equal(summary.nonStaticHolds, 1);
});

test('the balance refresh cue neither breaks a hold nor stalls a settle, while a real change still does', async (t) => {
  const { browser, GuardedFootage, sessionDir } = await recording(t);
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  // The cue stays mounted with its "Updating…" label, hidden while fresh.
  await page.setContent(
    '<body style="background:#222;color:#eee"><p id="bal">0.19 XMR</p>' +
      '<div data-testid="balance-freshness-cue" data-freshness="fresh" style="visibility:hidden">Updating…</div>' +
      '<button aria-label="Refresh balances" style="opacity:.75">R</button></body>',
  );
  await page.evaluate(() => {
    const cue = document.querySelector('[data-testid="balance-freshness-cue"]');
    const button = document.querySelector('button');
    setInterval(() => {
      const updating = cue.dataset.freshness !== 'updating';
      cue.dataset.freshness = updating ? 'updating' : 'fresh';
      cue.style.visibility = updating ? 'visible' : 'hidden';
      button.style.opacity = updating ? '0.4' : '0.75';
    }, 200);
  });
  const footage = new GuardedFootage({ policy: TEST_POLICY, staticPatienceMs: 3_000 });
  footage.attach('alice', page);
  const started = Date.now();
  await footage.settled(page, 'Home balances');
  assert.ok(Date.now() - started < 10_000, 'a hidden "Updating…" label does not stall the settle');
  await footage.result(page, 'Balance held through refreshes');
  // A real balance change, every 200 ms, is never a still screen.
  await page.evaluate(() => setInterval(() => (document.getElementById('bal').textContent = `${Math.random()} XMR`), 200));
  await footage.result(page, 'Balance that keeps changing');
  await footage.close();
  const lane = JSON.parse(readFileSync(join(sessionDir(footage), 'lane.json'), 'utf8'));
  assert.deepEqual(lane.holds.map((h) => h.static), [true, true, false]);
});
