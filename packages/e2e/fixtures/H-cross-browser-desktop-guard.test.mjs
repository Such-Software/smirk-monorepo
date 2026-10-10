// Area H capture guard, canary, recorder, sign-in budget, balance reference and live-spec lint.
// Run: node --test packages/e2e/fixtures/H-cross-browser-desktop-guard.test.mjs
// The guard cases run in real Chromium (playwright-core) like demo/guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { GUARD_RULES, MASKS, MASK_COLOR, MaskUnavailable, assertStaticLabel, makeCanary, verifyTimeline } from './H-cross-browser-desktop-policy.mjs';
import { hCanarySnapshot, hHeaderHitTest, hMaskCovered, hMaskOverlay, hMaskRemove, hSecretVerdict } from './H-cross-browser-desktop-guard.mjs';
import { FootageError, GuardedRecorder, imageSize, wrapLabel } from './H-cross-browser-desktop-recorder.mjs';
import { SignInLedger, pause } from './H-cross-browser-desktop-signin.mjs';
import { compareWithReference } from './H-cross-browser-desktop-reference.mjs';
import { readBalances as readDesktopBalances } from '../scripts/H-cross-browser-desktop-macos-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hex = 'ab'.repeat(32);
const nsec = `nsec1${'q'.repeat(58)}`;

// [name, html, fill (for the first input), expected card label or null, expected mask labels]
/** @type {Array<[string, string, string | null, string | null, string[]]>} */
const cases = [
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, null, []],
  ['the welcome screen', '<button data-testid="onboarding-import-btn">Import</button><button data-testid="onboarding-create-btn">Create</button>', null, null, []],
  ['a hidden password field', '<input type="password" style="display:none"><p>ok</p>', null, null, []],
  ['a password field below the fold', '<p>Settings</p><div style="height:3000px"></div><input type="password" data-testid="settings-reveal-password">', null, null, []],
  ['the lock screen', '<div data-testid="lockscreen-root"><input type="password" data-testid="lockscreen-password-input"><button data-testid="lockscreen-unlock-btn">Unlock</button></div>', null, null, ['Password field']],
  ['a typed lock screen password', '<div data-testid="lockscreen-root"><input type="password" data-testid="lockscreen-password-input"></div>', 'hunter2hunter2', null, ['Password field']],
  ['the Settings root', '<input type="password" data-testid="settings-reveal-password"><button data-testid="settings-reveal-btn">Show</button><button data-testid="require-password-sends" role="switch"></button><button data-testid="require-password-signing"></button>', null, null, ['Password field']],
  ['a revealed phrase', '<p data-testid="settings-revealed-phrase">words</p>', null, 'Recovery phrase reveal', []],
  ['an import word field', '<input data-testid="onboarding-import-word-0">', null, 'Recovery phrase entry', []],
  ['a generated phrase word', '<span data-testid="onboarding-create-seed-word-3">word</span>', null, 'Recovery phrase entry', []],
  ['a verify word field', '<input data-testid="onboarding-verify-word-1">', null, 'Recovery phrase entry', []],
  ['the phrase outranks other protected ids', '<button data-testid="onboarding-create-copy-seed">Copy</button><span data-testid="onboarding-create-seed-word-0">w</span>', null, 'Recovery phrase entry', []],
  ['the masked tx key control', '<button data-testid="tx-detail-reveal-key">Show transaction key</button>', null, null, []],
  ['a revealed tx key', `<code data-testid="tx-detail-tx-key">${hex}</code>`, null, null, ['Transaction key']],
  ['a transaction id outside Settings', `<p>Transaction</p><code>${hex}</code>`, null, null, []],
  ['the revealed raw key export', `<select data-testid="settings-autolock-select"></select><div>Private keys below, full spend access.</div><div>XMR private spend key</div><div>${hex}</div>`, null, 'Private key panel', []],
  ['the raw key labels without a test id', '<div>WOW private view key</div><div>Grin slatepack secret key</div>', null, 'Private key panel', []],
  ['a 64-hex run on a Settings screen', `<select data-testid="settings-autolock-select"></select><div>Smirk PoW gate hash</div><div>${hex}</div>`, null, 'Long hex in Settings', []],
  ['the export panel before the reveal', '<select data-testid="settings-autolock-select"></select><button>I understand the risk, reveal private keys</button>', null, null, []],
  ['a tip share url', '<div data-testid="tip-share-url">https://smirk.cash/tip/abcd</div>', null, null, ['Tip share link']],
  ['a claim link without a test id', '<p>https://smirk.cash/tip/AbC123#k3yFragment_xyz</p>', null, null, ['Tip claim link text']],
  ['an empty tip paste field', '<input data-testid="paste-tip-input">', null, null, []],
  ['a filled tip paste field', '<input data-testid="paste-tip-input">', 'something pasted', null, ['Tip paste field']],
  ['a claim link pasted into a field', '<input data-testid="paste-tip-input">', 'https://smirk.cash/tip/AbC123#k3yFragment_xyz', 'Secret-like field value', ['Tip paste field']],
  ['an empty nsec import field', '<input data-testid="nostr-import-nsec">', null, null, []],
  ['a filled nsec import field', '<input data-testid="nostr-import-nsec">', nsec, 'Secret-like field value', ['Nostr import field']],
  ['a shown nsec field', `<code data-testid="nostr-nsec-${hex}">x</code>`, null, null, ['Nostr key field']],
  ['an nsec in page text', `<p>${nsec}</p>`, null, 'Private key text', []],
  ['an xprv in page text', `<p>xprv${'A'.repeat(40)}</p>`, null, 'Private key text', []],
  ['an npub in page text', `<p>npub1${'q'.repeat(58)}</p>`, null, null, []],
  ['the identity reveal button', `<button data-testid="nostr-reveal-${hex}">Reveal</button>`, null, null, []],
  ['an unknown protected surface', '<div data-testid="wallet-export-keys">keys</div>', null, 'Protected surface', []],
  ['a swap private link', '<a data-testid="swap-status-private-link">link</a>', null, null, ['Swap private link']],
  ['the unlock prompts', '<button data-testid="bootstrap-error-unlock">Unlock</button><div data-testid="legacy-needs-unlock">Unlock</div><div data-testid="nostr-unlock-prompt">Unlock</div>', null, null, []],
];

test('the H guard cards phrase and key surfaces, masks in-viewport password and claim surfaces, and admits the documented controls', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const [name, html, fill, card, mask] of cases) {
      await page.setContent(html);
      if (fill) await page.fill('input', fill);
      const verdict = await page.evaluate(hSecretVerdict, GUARD_RULES);
      assert.equal(verdict.card[0] ?? null, card, `${name}: card`);
      assert.deepEqual(verdict.mask, [...mask].sort(), `${name}: masks`);
    }
  } finally {
    await browser.close();
  }
});

/** Run a self-contained guard function the way WebDriver does: as source, with positional arguments. */
const inPage = (page, fn, ...args) => page.evaluate(`(${String(fn)}).apply(null, ${JSON.stringify(args)})`);

test('the Firefox overlay covers every in-viewport masked field, proves it, and refuses what it cannot cover', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  const selectors = [MASKS['Password field'].css];
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await page.setContent('<div data-testid="lockscreen-root"><p>Locked</p><input type="password" data-testid="lockscreen-password-input"></div><div style="height:3000px"></div><input type="password">');
    assert.equal(await inPage(page, hMaskOverlay, selectors, MASK_COLOR, 'one'), 2, 'one box per field, on screen or not');
    assert.equal(await inPage(page, hMaskCovered, selectors, 'one'), true, 'the on-screen field is covered at its centre and corners');
    await page.evaluate(() => { /** @type {HTMLElement} */ (document.querySelector('[data-testid="lockscreen-password-input"]')).style.marginLeft = '120px'; });
    assert.equal(await inPage(page, hMaskCovered, selectors, 'one'), false, 'a field that moved out from under its box is not covered');
    assert.equal(await inPage(page, hMaskRemove, 'one'), true);
    assert.equal(await inPage(page, hMaskCovered, selectors, 'one'), false, 'no boxes, no cover');
    // A field in the top layer (a modal dialog) renders above any z-index.
    await page.setContent('<dialog id="d"><input type="password"></dialog>');
    await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('d')).showModal());
    await inPage(page, hMaskOverlay, selectors, MASK_COLOR, 'two');
    assert.equal(await inPage(page, hMaskCovered, selectors, 'two'), false, 'the top layer wins over the overlay, so the frame must become a card');
    await inPage(page, hMaskOverlay, selectors, MASK_COLOR, 'three');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-h-mask]').length), 1, 'a new overlay drops any left over');
    assert.equal(await inPage(page, hMaskRemove, null), true, 'remove-all clears every overlay');
  } finally {
    await browser.close();
  }
});

test('the canary snapshot carries field values and the header hit test finds covered buttons', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await page.setContent('<p>visible</p><input value="typed">');
    const snapshot = await page.evaluate(hCanarySnapshot);
    assert.ok(snapshot.text.includes('visible'));
    assert.deepEqual(snapshot.values, ['typed']);
    await page.setContent(`<div data-testid="app-shell-root" data-layout="popup"><header style="display:flex">
      <button aria-label="Refresh balances">r</button><button aria-label="Lock wallet">l</button>
      <button aria-label="Covered" style="position:relative">c</button></header>
      <div style="position:absolute;top:0;left:0;width:380px;height:60px;z-index:5"></div></div>`);
    const report = await page.evaluate(hHeaderHitTest);
    assert.equal(report.layout, 'popup');
    assert.equal(report.bar, 'header');
    assert.equal(report.buttons.length, 3);
    assert.ok(report.buttons.some((button) => !button.hit), 'an overlaid button is reported as not hit');
  } finally {
    await browser.close();
  }
});

test('the canary finds phrase runs, phrase fields and exact secrets without keeping plaintext', () => {
  const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
  const password = 'Zq3-rT9_pLm0vX8bYc2';
  const canary = makeCanary({ phraseWords: [...words], exact: [password] });
  assert.equal(canary.check({ text: 'Send fee swap balance', values: [] }), null);
  assert.equal(canary.check({ text: 'able about', values: [] }), null, 'two words are ordinary text');
  assert.equal(canary.check({ text: 'about able ability', values: [] }), null, 'out of order is not a run');
  assert.ok(canary.check({ text: 'header ability able about footer', values: [] }));
  assert.ok(canary.check({ text: '01 abandon 02 ability 03 able', values: [] }), 'grid numbering does not hide a run');
  assert.ok(canary.check({ text: '', values: ['absent', 'absorb', 'abuse'] }), 'three phrase words in fields');
  assert.ok(canary.check({ text: `token ${password} token`, values: [] }));
  assert.ok(canary.check({ text: '', values: [`prefix${password}suffix`] }));
  assert.ok(canary.check({ text: `x${password}y`, values: [] }), 'a secret inside a longer token');
  assert.equal(canary.check({ text: 'K3yFragment_unknown_zz', values: [] }), null);
  canary.remember('K3yFragment_unknown_zz');
  assert.ok(canary.check({ text: 'see K3yFragment_unknown_zz', values: [] }), 'remembered secrets are found');
  assert.equal(JSON.stringify(canary).includes(password), false, 'no plaintext is retained');
});

test('labels are static and timelines enforce the owner holds, in sequence', () => {
  for (const ok of ['Tap Send', 'Choose Monero', 'Home balances', 'Live swap quote, not confirmed', 'Import alice: phrase and password entry']) {
    assert.equal(assertStaticLabel(ok), ok);
  }
  for (const bad of ['https://smirk.cash/tip/x', `key ${hex}`, '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3', 'Amount 123456', '', 'x'.repeat(90), 42]) {
    assert.throws(() => assertStaticLabel(bad));
  }
  const holds = { preTapMs: 6000, settledMs: 12000, resultMs: 25000 };
  const settled = (label) => ({ kind: 'settled', label, holdMs: 12000 });
  const tap = (label) => ({ kind: 'tap', label, holdMs: 6000 });
  const good = {
    frames: [{ at: 0, file: 'frames/0.jpg', verdict: 'clean' }, { at: 1, file: null, card: 'Unlock', verdict: 'card' }],
    events: [
      settled('Home'),
      tap('Tap Send'),
      settled('Send asset picker'),
      tap('Choose Monero'),
      { kind: 'result', label: 'Home balances', holdMs: 25000 },
      { kind: 'secret', label: 'Unlock with the password', holdMs: 9000, preHoldMs: 6000 },
      { kind: 'chapter', label: 'Waiting', holdMs: 0 },
      settled('Home after unlock'),
    ],
  };
  assert.deepEqual(verifyTimeline(good, holds), []);
  assert.ok(verifyTimeline({ ...good, events: [settled('Home'), { kind: 'tap', label: 'Tap Send', holdMs: 5999 }] }, holds).length);
  assert.ok(verifyTimeline({ ...good, events: [{ kind: 'result', label: 'Home balances', holdMs: 1000 }] }, holds).length);
  assert.ok(verifyTimeline({ ...good, events: [tap('Tap Send')] }, holds).length, 'a tap on a screen that was never held');
  assert.ok(verifyTimeline({ ...good, events: [settled('Home'), tap('Tap Receive'), tap('Choose Monero')] }, holds).length, 'a screen tapped through without its 12 s still');
  assert.ok(verifyTimeline({ ...good, events: [settled('Home'), tap('Tap Send'), { kind: 'chapter', label: 'Picker', holdMs: 0 }, tap('Choose Monero')] }, holds).length, 'a chapter is not a hold');
  assert.ok(verifyTimeline({ ...good, events: [settled('Home'), { kind: 'secret', label: 'Unlock', holdMs: 9000, preHoldMs: 10 }] }, holds).length, 'a secret scope without its pre-tap still');
  assert.ok(verifyTimeline({ ...good, frames: [{ at: 0, file: 'frames/0.jpg' }] }, holds).length, 'a frame without a verdict');
  assert.ok(verifyTimeline({ ...good, frames: [{ at: 0, file: 'frames/0.jpg', verdict: 'card', card: 'x' }] }, holds).length, 'a card with a screenshot');
  assert.equal(wrapLabel('one two three four', 9), 'one two\nthree\nfour');
});

/** A scripted page: verdicts and screenshots come from queues. */
class FakeAdapter {
  imageExt = 'png';
  constructor(maskMode = 'mask') {
    this.maskMode = maskMode;
    this.verdicts = [];
    this.text = '';
    this.shots = 0;
    this.maskedShots = [];
    this.coverFails = false;
    this.clicks = [];
  }
  async evaluate(fn) {
    if (fn === hCanarySnapshot) return { text: this.text, values: [] };
    return this.verdicts.length > 1 ? this.verdicts.shift() : (this.verdicts[0] ?? { card: [], mask: [] });
  }
  async screenshot(masks = []) {
    if (masks.length && this.coverFails) throw new MaskUnavailable('not covered');
    this.shots++;
    if (masks.length) this.maskedShots.push([...masks]);
    // A tiny valid PNG header is enough for imageSize; content varies by state.
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.writeUInt32BE(380, 16);
    buffer.writeUInt32BE(600, 20);
    buffer.write(this.text.slice(0, 8), 24);
    return buffer;
  }
  async click(target) { this.clicks.push(target); }
  async fill() {}
  async choose() {}
  async press() {}
  async rootText() { return this.text; }
}

const fastHolds = { preTapMs: 50, settledMs: 80, resultMs: 100 };

test('the recorder dedupes still frames, cards secret scopes and masks, and drops disagreeing passes', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const holds = { preTapMs: 120, settledMs: 150, resultMs: 200 };
  const adapter = new FakeAdapter('mask');
  const canary = makeCanary({ exact: ['CorrectHorseBattery9'] });
  const recorder = new GuardedRecorder({ adapter, lane: 'test lane', outDir: out, canary, holds, interval: 20 });
  try {
    adapter.text = 'Home';
    recorder.start();
    await recorder.settled('Home');
    const storedAfterStill = recorder.stats.stored;
    assert.equal(storedAfterStill, 1, 'a still screen is stored once');

    const shotsBefore = adapter.shots;
    await recorder.secret('Unlock with the password', async (ops) => {
      await ops.fill('lockscreen-password-input', 'CorrectHorseBattery9');
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    const during = recorder.frames.filter((frame) => frame.verdict === 'card' && frame.card === 'Unlock with the password');
    assert.ok(during.length >= 1, 'the secret scope shows its card');
    assert.ok(adapter.shots - shotsBefore <= 12, 'only the pre-hold and the resume checks take screenshots');
    const secret = recorder.events.find((event) => event.kind === 'secret');
    assert.ok(secret.preHoldMs >= holds.preTapMs, 'a secret scope starts with the pre-tap still');

    adapter.text = 'leak CorrectHorseBattery9';
    await recorder.result('Canary');
    assert.ok(recorder.frames.some((frame) => frame.card === 'Known secret visible'), 'a canary hit cards the frame');
    adapter.text = 'Home';

    adapter.verdicts = [{ card: [], mask: [] }, { card: [], mask: ['Password field'] }];
    await recorder.tap('home-action-send', 'Tap Send');
    assert.ok(recorder.stats.dropped >= 1, 'a disagreeing second pass drops the frame');
    assert.deepEqual(adapter.clicks, ['home-action-send']);

    const timeline = await recorder.stop();
    assert.deepEqual(verifyTimeline(timeline, holds), []);
    assert.ok(timeline.events.find((event) => event.kind === 'tap').holdMs >= holds.preTapMs);
    const written = JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'));
    assert.equal(JSON.stringify(written).includes('CorrectHorse'), false, 'the timeline holds no secret');
    assert.deepEqual(imageSize(await adapter.screenshot()), { width: 380, height: 600 });
  } finally {
    if (!recorder.stopped) await recorder.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

test('every screen an interaction leaves gets its settled still before the next interaction', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('mask');
  const recorder = new GuardedRecorder({ adapter, lane: 'settle test', outDir: out, canary: makeCanary(), holds: fastHolds, interval: 20 });
  try {
    recorder.start();
    // No settled() anywhere: the recorder must hold each screen itself.
    await recorder.tap('home-action-receive', 'Tap Receive');
    await recorder.tap('receive-asset-xmr', 'Choose Monero');
    await recorder.type('send-amount-input', '0.0001', 'Enter a small amount');
    await recorder.secret('Unlock with the password', async () => {});
    const timeline = await recorder.stop();
    assert.equal(recorder.stats.autoSettled, 4, 'one held still per unheld screen, the opening one included');
    const kinds = timeline.events.map((event) => event.kind).join(' ');
    assert.equal(kinds, 'settled tap settled tap settled tap settled secret');
    assert.deepEqual(verifyTimeline(timeline, fastHolds), []);
  } finally {
    if (!recorder.stopped) await recorder.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

test('a recorder refuses a directory that already holds a run', () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  try {
    mkdirSync(join(out, 'frames'));
    writeFileSync(join(out, 'frames', '000000.png'), 'x');
    assert.throws(() => new GuardedRecorder({ adapter: new FakeAdapter(), lane: 'reuse', outDir: out, canary: makeCanary() }), FootageError);
    rmSync(join(out, 'frames', '000000.png'));
    writeFileSync(join(out, 'timeline.json'), '{}');
    assert.throws(() => new GuardedRecorder({ adapter: new FakeAdapter(), lane: 'reuse', outDir: out, canary: makeCanary() }), FootageError);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a failed secret scope reports its own error and keeps the card until the screen is clean', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('mask');
  const recorder = new GuardedRecorder({ adapter, lane: 'failure test', outDir: out, canary: makeCanary(), holds: fastHolds, interval: 20 });
  try {
    adapter.verdicts = [{ card: ['Recovery phrase entry'], mask: [] }];
    recorder.start();
    await assert.rejects(recorder.secret('Import alice: phrase and password entry', async () => { throw new Error('scope failed'); }), /scope failed/);
    assert.equal(recorder.secretLabel, 'Import alice: phrase and password entry', 'the card stays on while the phrase is visible');
    const shots = adapter.shots;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(adapter.shots, shots, 'no screenshots while the failed scope is open');
    adapter.verdicts = [{ card: [], mask: [] }];
    assert.equal(await recorder.resume(), true);
    assert.equal(recorder.secretLabel, null);
  } finally {
    if (!recorder.stopped) await recorder.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

test('without masks a mask-level surface becomes a full card', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('card');
  const recorder = new GuardedRecorder({ adapter, lane: 'card test', outDir: out, canary: makeCanary(), holds: fastHolds, interval: 20 });
  try {
    adapter.verdicts = [{ card: [], mask: ['Password field'] }];
    recorder.start();
    await recorder.result('Lock screen');
    await recorder.stop();
    assert.equal(adapter.shots, 0, 'no screenshot is taken of a masked surface');
    assert.ok(recorder.frames.every((frame) => frame.verdict === 'card' && frame.card === 'Password field'));
  } finally {
    if (!recorder.stopped) await recorder.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

test('Firefox overlays record a masked frame, and an unproven cover or an unaddressable kind becomes a card', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('overlay');
  const recorder = new GuardedRecorder({ adapter, lane: 'overlay test', outDir: out, canary: makeCanary(), holds: fastHolds, interval: 20 });
  try {
    adapter.verdicts = [{ card: [], mask: ['Password field'] }];
    recorder.start();
    await recorder.result('Lock screen');
    assert.ok(adapter.maskedShots.length >= 1, 'the screenshot is taken with the mask kinds to cover');
    assert.ok(recorder.frames.some((frame) => frame.verdict === 'masked' && frame.file), 'the lock screen is recorded, masked');
    const before = recorder.frames.length;
    adapter.coverFails = true;
    await recorder.result('Settings');
    // A frame screenshotted before the switch may still land; from the first card on, only cards.
    const after = recorder.frames.slice(before);
    const firstCard = after.findIndex((frame) => frame.verdict === 'card');
    assert.ok(firstCard >= 0, 'an unproven cover cards the frame');
    assert.ok(after.slice(firstCard).every((frame) => frame.verdict === 'card' && frame.card === 'Password field'), 'and keeps carding while it cannot be proven');
    // Let any frame already in flight finish before the next switch is measured.
    const cycle = () => new Promise((resolve) => setTimeout(resolve, 80));
    adapter.coverFails = false;
    adapter.verdicts = [{ card: [], mask: ['Tip claim link text'] }];
    await cycle();
    const shotsBefore = adapter.shots;
    await recorder.result('Claim link');
    assert.equal(adapter.shots, shotsBefore, 'a kind with no selector is never screenshotted');
    assert.ok(recorder.frames.some((frame) => frame.card === 'Tip claim link text'));
  } finally {
    if (!recorder.stopped) await recorder.stop();
    rmSync(out, { recursive: true, force: true });
  }
});

test('the sign-in ledger admits a lane only when its plan fits the hour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-ledger-'));
  let now = 10_000_000;
  const hour = 3_600_000;
  try {
    const ledger = new SignInLedger(join(dir, 'ledger.jsonl'), { lane: 'chromium', budget: 24, now: () => now });
    assert.equal(ledger.admissibleAt(10), now, 'an empty ledger admits at once');
    assert.equal(ledger.admissibleAt(25), Infinity, 'a plan past the budget never fits');
    for (let i = 0; i < 20; i++) {
      ledger.record('unlock');
      now += 60_000;
    }
    // 20 used, 10 planned: 6 must age out; the 6th oldest was recorded at start + 5 min.
    assert.equal(ledger.used().length, 20);
    assert.equal(ledger.admissibleAt(10), 10_000_000 + 5 * 60_000 + hour);
    assert.equal(ledger.admissibleAt(4), now, 'a plan that fits is admitted now');
    now += hour;
    assert.equal(ledger.used().length, 0, 'entries older than the hour no longer count');
    writeFileSync(join(dir, 'ledger.jsonl'), 'not json\n{"at":"x"}\n', { flag: 'a' });
    assert.equal(ledger.entries().length, 20, 'malformed lines are ignored');
    const started = Date.now();
    assert.equal(await pause(5_000, () => true), false, 'a pause stops when told to');
    assert.ok(Date.now() - started < 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the desktop comparison runs only on comparable reads and names why it cannot', () => {
  const balances = { btc: '0.001', ltc: '0.5', xmr: '0.19', wow: '19.78', grin: '0' };
  const readAt = Date.parse('2026-10-10T12:00:00Z');
  const reference = (minutesBefore, extra = {}) => ({ readAt: new Date(readAt - minutesBefore * 60_000).toISOString(), balances: { ...balances }, moving: [], ...extra });
  assert.equal(compareWithReference(reference(10), { balances, readAt }).ok, true);
  assert.match(compareWithReference(reference(45), { balances, readAt }).reason, /min old/);
  assert.match(compareWithReference(reference(-5), { balances, readAt }).reason, /after the desktop read/);
  assert.match(compareWithReference(reference(10, { moving: ['xmr'] }), { balances, readAt }).reason, /moving when Chromium/);
  assert.match(compareWithReference(reference(10, { moving: undefined }), { balances, readAt }).reason, /moving when Chromium/, 'an old reference without the field is not trusted');
  assert.match(compareWithReference(reference(10), { balances, moving: ['wow'], readAt }).reason, /moving on the desktop/);
  const differ = compareWithReference(reference(10), { balances: { ...balances, xmr: '0' }, readAt });
  assert.deepEqual(differ.differ, ['xmr']);
  assert.equal(compareWithReference(null, { balances, readAt }).ok, false);
});

test('the desktop reader finds each Home row and the rows with funds in motion', () => {
  const texts = ['Total', 'Bitcoin', 'BTC', '0.001', '$60.00', 'Litecoin', 'LTC', '0.5', 'Monero', 'XMR', '0.19', '↑ 0.01 XMR sending', 'Wownero', 'WOW', '19.78', 'Grin', 'GRIN', '0', 'No pending tips'];
  const { balances, moving } = readDesktopBalances(texts);
  assert.deepEqual(balances, { btc: '0.001', ltc: '0.5', xmr: '0.19', wow: '19.78', grin: '0' });
  assert.deepEqual(moving, ['xmr'], 'only the row whose own sublines say so; text further down is not a row');
});

test('live H specs act only through the recorder helpers and wait on conditions, not fixed sleeps', () => {
  const spec = readFileSync(join(here, '..', 'tests', 'live', 'h-firefox.live.mjs'), 'utf8');
  const driver = readFileSync(join(here, '..', 'scripts', 'H-cross-browser-desktop-macos-driver.mjs'), 'utf8');
  const shell = readFileSync(join(here, '..', 'scripts', 'desktop-smoke-macos.sh'), 'utf8');
  const offenders = [];
  for (const match of spec.matchAll(/([A-Za-z_$][\w$.]*)\.(click|fill|sendKeys|selectOption|check|type|tap|press|choose)\(/g)) {
    const receiver = match[1];
    if (/(^|\.)footage$/.test(receiver) || receiver === 'ops') continue;
    // Zeroing an array of phrase words is not an interaction.
    if (match[2] === 'fill' && spec.startsWith("'')", match.index + match[0].length)) continue;
    offenders.push(`${receiver}.${match[2]}`);
  }
  assert.deepEqual(offenders, [], 'raw interactions bypass the hold and guard policy');
  // Holds come from the recorder and waits from until() or pause(): a sleep
  // may only take a poll interval or a still's tick, never a literal.
  const allowed = new Set(['every', 'POLL_MS', 'WATCH_MS', 'tick']);
  for (const [name, source] of [['the live spec', spec], ['the desktop driver', driver]]) {
    const sleeps = [...source.matchAll(/\bsleep\(\s*([^)]*)\)/g)].map((match) => match[1].trim());
    assert.deepEqual(sleeps.filter((arg) => !allowed.has(arg)), [], `${name} sleeps a fixed time instead of waiting on a condition`);
    assert.equal(/\bsetTimeout\(/.test(source), false, `${name} hides a fixed wait in setTimeout`);
  }
  const shellSleeps = shell.split('\n').filter((line) => !/^\s*#/.test(line) && /(^|[\s;&|])sleep\s/.test(line) && !/#\s*poll\b/.test(line));
  assert.deepEqual(shellSleeps, [], 'the desktop smoke sleeps outside a bounded condition poll');
});
