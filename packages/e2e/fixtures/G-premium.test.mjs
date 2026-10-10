// G-premium capture lane: the frame guard, the canary, label policy, the
// recorder against a synthetic page, timeline validation and lane planning,
// and a lint of the live spec. Runs in real Chromium; no wallet is involved.
//
//   node --test packages/e2e/fixtures/G-premium.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PREMIUM_GUARD, frameVerdict } from './G-premium-guard.mjs';
import { GuardedFootage, SecretCanary, assertStaticLabel, footageRequested } from './G-premium-footage.ts';
import { captionWindows, planLanes, validateTimeline } from '../scripts/G-premium-footage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hex = 'ab'.repeat(32);

const cases = [
  // [name, html, fill, verdict]
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, 'clean'],
  ['the premium purchase screen', '<div data-testid="premium-purchase"><button data-testid="premium-buy">Get premium</button></div>', null, 'clean'],
  ['the lock screen', '<input type="password" data-testid="lockscreen-password-input"><button data-testid="lockscreen-unlock-btn">Unlock</button>', null, 'masked'],
  ['the operation password dialog', '<input type="password" data-testid="operation-password">', 'x', 'masked'],
  ['a hidden password field', '<input type="password" style="display:none"><p>ok</p>', null, 'clean'],
  ['a phrase entry field', '<input data-testid="onboarding-import-word-0">', null, 'card'],
  ['a generated phrase word', '<span data-testid="onboarding-create-seed-word-3">word</span>', null, 'card'],
  ['a revealed phrase', '<div data-testid="settings-revealed-phrase">words</div>', null, 'card'],
  ['the settings reveal button', '<button data-testid="settings-reveal-btn">Show recovery phrase</button>', null, 'clean'],
  ['the tx key reveal button', '<button data-testid="tx-detail-reveal-key">Reveal</button>', null, 'clean'],
  ['a revealed tx key', '<code data-testid="tx-detail-tx-key">abc</code>', null, 'masked'],
  ['an nsec in page text', '<p>nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'card'],
  ['an xprv in an input', '<input data-testid="x">', `xprv${'9'.repeat(30)}`, 'card'],
  ['an npub in page text', '<p>npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq</p>', null, 'clean'],
  ['a tip claim link in text', '<p>https://smirk.cash/tip/abc123#k3y</p>', null, 'card'],
  ['a tip link without a key', '<p>https://smirk.cash/tip/abc123</p>', null, 'clean'],
  ['the identity reveal button', `<button data-testid="nostr-reveal-${hex}">Reveal</button>`, null, 'clean'],
  ['the empty nsec import field', '<input data-testid="nostr-import-nsec">', null, 'masked'],
  ['a filled paste field', '<textarea data-testid="paste-tip-input"></textarea>', 'something', 'masked'],
];

test('the frame guard sorts each surface into clean, masked or card', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, expected] of cases) {
      await page.setContent(html);
      if (fill) await page.fill('input, textarea', fill);
      const seen = await page.evaluate(frameVerdict, PREMIUM_GUARD);
      assert.equal(seen.verdict, expected, `${name}: expected ${expected}, got ${seen.verdict} (${seen.reason})`);
      assert.ok(!/[0-9a-f]{16}|nsec1|xprv|#k3y/.test(seen.reason), `${name}: a reason must name a kind, not content`);
    }
    await page.setContent('<input type="password" data-testid="lockscreen-password-input">');
    assert.equal((await page.evaluate(frameVerdict, PREMIUM_GUARD)).filledSecret, false);
    await page.fill('input', 'typed');
    assert.equal((await page.evaluate(frameVerdict, PREMIUM_GUARD)).filledSecret, true);
  } finally {
    await browser.close();
  }
});

test('the canary trips on a known password or three phrase words in order, and on nothing else', () => {
  const canary = new SecretCanary();
  const password = randomBytes(18).toString('base64url');
  canary.addValue(password);
  canary.addPhrase(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']);
  assert.equal(canary.hit(`before ${password} after`, []), true);
  assert.equal(canary.hit('', [password]), true);
  assert.equal(canary.hit('Words: Delta, ECHO; foxtrot.', []), true);
  assert.equal(canary.hit('', ['golf hotel india']), true);
  assert.equal(canary.hit('alpha charlie bravo', []), false);
  assert.equal(canary.hit('alpha bravo', []), false);
  assert.equal(canary.hit('Founding member, 1 year, 5 USD', []), false);
  canary.clear();
  assert.equal(canary.hit(password, []), false);
});

test('labels are static phrases and footage modes are explicit', () => {
  for (const ok of ['Get premium', 'Founding member, 1 year', 'Check now', "Owner's checkout"]) assert.doesNotThrow(() => assertStaticLabel(ok));
  for (const bad of ['https://example.org/i/abc', 'Invoice 3CmYa8kQ2u9xPq7WvR4tZ1', 'Invoice Ab3dE5gH7jK9', 'Paid 0.07861234', 'tx ' + hex, '', 'x'.repeat(81)]) {
    assert.throws(() => assertStaticLabel(bad));
  }
  assert.equal(footageRequested({}), false);
  assert.equal(footageRequested({ FOOTAGE: 'guarded' }), true);
  assert.throws(() => footageRequested({ FOOTAGE: 'on' }));
});

test('the recorder keeps clean and masked frames, cards secrets, and dedupes static holds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smirk-G-premium-test-'));
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({ viewport: { width: 380, height: 600 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const footage = new GuardedFootage({ recording: true, root });
    const password = randomBytes(18).toString('base64url');
    footage.canary.addValue(password);
    await page.setContent('<div id="root"><h1>Feed</h1><p>Posting needs premium.</p></div>');
    footage.attach(page, { name: 'alice', wallet: 'alice', role: 'main' });
    footage.watch(context, 'alice');
    footage.mark('Synthetic run', 'alice');
    await page.waitForTimeout(1_500);
    await page.setContent('<div id="root"><input type="password" data-testid="lockscreen-password-input"></div>');
    await page.waitForTimeout(1_000);
    await footage.secret('Unlocking the wallet', async () => {
      await page.fill('input', password);
      await page.waitForTimeout(600);
      await page.setContent('<div id="root"><p>Home</p></div>');
    });
    await page.setContent('<div id="root"><span data-testid="onboarding-import-word-0">x</span></div>');
    await page.waitForTimeout(800);
    await page.setContent(`<div id="root"><p>${password}</p></div>`);
    await page.waitForTimeout(800);
    await page.setContent('<div id="root"><p>Home</p></div>');
    const tab = await context.newPage();
    await tab.setContent('<p>Checkout BTC LTC</p>');
    await tab.waitForTimeout(800);
    await tab.close();
    await page.waitForTimeout(800);
    await footage.close();

    const runDir = footage.runDir;
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    const timeline = JSON.parse(readFileSync(join(runDir, 'timeline.json'), 'utf8'));
    assert.deepEqual(validateTimeline(timeline, runDir), []);
    const alice = timeline.tracks.find((track) => track.name === 'alice');
    const verdicts = alice.segments.map((segment) => segment.verdict);
    assert.ok(verdicts.includes('clean'));
    assert.ok(verdicts.includes('masked'), 'the lock screen is recorded with its field masked');
    const cards = alice.segments.filter((segment) => segment.verdict === 'card');
    assert.ok(cards.some((segment) => segment.card === 'Unlocking the wallet'), 'the secret scope shows its card');
    assert.ok(cards.length >= 2, 'the phrase field and the canary hit are carded too');
    assert.ok(cards.every((segment) => segment.file === undefined), 'a card keeps no pixels');
    // Static stretches are one stored frame each, not one per tick.
    const files = readdirSync(join(runDir, 'alice'));
    assert.ok(files.length < alice.segments.length + 1 && files.length <= 8, `expected deduplicated frames, found ${files.length}`);
    for (const file of files) assert.equal(statSync(join(runDir, 'alice', file)).mode & 0o777, 0o600);
    // The password never reaches disk.
    for (const file of ['timeline.json', 'evidence.json']) assert.ok(!readFileSync(join(runDir, file), 'utf8').includes(password));
    assert.ok(timeline.tracks.some((track) => track.role === 'secondary' && track.wallet === 'alice'), 'the opened tab was recorded');
    const lanes = planLanes(timeline);
    assert.deepEqual(lanes.map((lane) => lane.title), ['alice', 'alice windows']);
    for (const lane of lanes) {
      assert.equal(lane.pieces[0].from, timeline.startedAt);
      assert.equal(lane.pieces.at(-1).to, timeline.endedAt);
      for (let i = 1; i < lane.pieces.length; i++) assert.equal(lane.pieces[i].from, lane.pieces[i - 1].to, 'lanes have no gaps');
    }
    assert.ok(captionWindows(timeline).operations.length >= 1);
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('processing refuses unguarded frames, short holds, unsafe labels and stray files', () => {
  const base = () => ({
    area: 'G-premium', schema: 1, startedAt: 0, endedAt: 60_000,
    policy: { tapPauseMs: 6_000, settledHoldMs: 12_000, resultHoldMs: 25_000 },
    tracks: [{ name: 'alice', dir: 'alice', wallet: 'alice', role: 'main', startedAt: 0, endedAt: null,
      segments: [{ from: 0, to: 10, verdict: 'clean', file: 'alice/000000.jpg' }, { from: 10, to: 20, verdict: 'card', card: 'Importing a demo wallet' }] }],
    holds: [{ kind: 'result', label: 'Premium is active', ms: 25_000 }],
    marks: [{ label: 'Premium purchase', wallet: 'alice', at: 0 }],
  });
  const exists = () => true;
  assert.deepEqual(validateTimeline(base(), '/run', exists), []);
  const refusals = [
    (t) => { delete t.tracks[0].segments[0].verdict; },
    (t) => { t.tracks[0].segments[0].verdict = 'unchecked'; },
    (t) => { t.holds[0].ms = 24_000; },
    (t) => { t.holds.push({ kind: 'tap', label: 'Check now', ms: 5_000 }); },
    (t) => { t.holds[0].label = 'https://pay.example.org/i/x'; },
    (t) => { t.marks[0].label = `tx ${hex}`; },
    (t) => { t.tracks[0].segments[0].file = '../elsewhere.jpg'; },
    (t) => { t.tracks[0].segments[1].file = 'alice/000001.jpg'; },
    (t) => { t.policy.resultHoldMs = 10_000; },
  ];
  for (const mutate of refusals) {
    const timeline = base();
    mutate(timeline);
    assert.notDeepEqual(validateTimeline(timeline, '/run', exists), [], `expected a refusal for ${mutate}`);
  }
  assert.notDeepEqual(validateTimeline(base(), '/run', () => false), [], 'a missing frame file refuses');
});

test('the window lane follows the window acted on most recently', () => {
  const timeline = {
    startedAt: 0, endedAt: 100,
    tracks: [
      { name: 'alice', dir: 'alice', wallet: 'alice', role: 'main', startedAt: 0, endedAt: null, segments: [{ from: 0, to: 100, verdict: 'clean', file: 'alice/0.jpg' }] },
      { name: 'alice-window-1', dir: 'alice-window-1', wallet: 'alice', role: 'secondary', startedAt: 10, endedAt: 90, segments: [{ from: 10, to: 90, verdict: 'clean', file: 'alice-window-1/0.jpg' }] },
      { name: 'alice-second-window', dir: 'alice-window-2', wallet: 'alice', role: 'secondary', startedAt: 30, endedAt: 70, segments: [{ from: 30, to: 70, verdict: 'masked', file: 'alice-window-2/0.jpg' }] },
    ],
    focus: [{ track: 'alice-window-1', at: 10 }, { track: 'alice-window-2', at: 30 }, { track: 'alice-window-1', at: 50 }],
  };
  const [, windows] = planLanes(timeline);
  const at = (t) => windows.pieces.find((piece) => piece.from <= t && t < piece.to);
  assert.equal(at(5).card, 'No other window open');
  assert.equal(at(20).file, 'alice-window-1/0.jpg');
  assert.equal(at(40).file, 'alice-window-2/0.jpg');
  assert.equal(at(60).file, 'alice-window-1/0.jpg');
  assert.equal(at(95).card, 'No other window open');
});

test('the live spec acts only through the footage helpers, with static labels', () => {
  const spec = readFileSync(join(here, '..', 'tests', 'live', 'g-premium.live.spec.ts'), 'utf8');
  const code = spec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const direct = code.match(/\.(click|dblclick|fill|press|pressSequentially|type|check|uncheck|selectOption|setInputFiles|tap)\(/g) ?? [];
  const allowed = code.match(/footage\.(tap|type)\(/g) ?? [];
  assert.equal(direct.length, allowed.length, 'a live spec acts on the page only through footage.tap and footage.type');
  const literal = String.raw`(?:'[^'\n]*'|\w+ === '[^'\n]*' \? '[^'\n]*' : '[^'\n]*')`;
  for (const call of code.matchAll(/footage\.(tap|type|closePage|settled|result)\(([^;]*?)\);/gs)) {
    assert.match(call[2].trim(), new RegExp(`,\\s*${literal}\\s*,?$`), `footage.${call[1]} needs a literal label: ${call[2].slice(0, 60)}`);
  }
  for (const call of code.matchAll(/footage\.(mark|secret)\(\s*([^,]+),/g)) {
    assert.match(call[2].trim(), new RegExp(`^${literal}$`), `footage.${call[1]} needs a literal label`);
  }
  assert.ok(!/console\.(log|info|error|warn)\(/.test(code), 'the live spec prints nothing');
  assert.ok(!/waitForTimeout\(/.test(code), 'holds come from the footage helpers, not ad hoc sleeps');
  assert.ok(existsSync(join(here, 'G-premium-footage.ts')));
});
