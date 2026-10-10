// Area H capture guard, canary, recorder and live-spec lint.
// Run: node --test packages/e2e/fixtures/H-cross-browser-desktop-guard.test.mjs
// The guard cases run in real Chromium (playwright-core) like demo/guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { GUARD_RULES, assertStaticLabel, makeCanary, verifyTimeline } from './H-cross-browser-desktop-policy.mjs';
import { hCanarySnapshot, hHeaderHitTest, hSecretVerdict } from './H-cross-browser-desktop-guard.mjs';
import { GuardedRecorder, imageSize, wrapLabel } from './H-cross-browser-desktop-recorder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hex = 'ab'.repeat(32);
const nsec = `nsec1${'q'.repeat(58)}`;

// [name, html, fill (for the first input), expected card label or null, expected mask labels]
/** @type {Array<[string, string, string | null, string | null, string[]]>} */
const cases = [
  ['a balance screen', '<div data-testid="home-total-balance">$1</div>', null, null, []],
  ['the welcome screen', '<button data-testid="onboarding-import-btn">Import</button><button data-testid="onboarding-create-btn">Create</button>', null, null, []],
  ['a hidden password field', '<input type="password" style="display:none"><p>ok</p>', null, null, []],
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

test('the H guard cards phrase surfaces, masks password and claim surfaces, and admits the documented controls', async () => {
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

test('labels are static and timelines enforce the owner holds', () => {
  for (const ok of ['Tap Send', 'Choose Monero', 'Home balances', 'Live swap quote, not confirmed', 'Import alice: phrase and password entry']) {
    assert.equal(assertStaticLabel(ok), ok);
  }
  for (const bad of ['https://smirk.cash/tip/x', `key ${hex}`, '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3', 'Amount 123456', '', 'x'.repeat(90), 42]) {
    assert.throws(() => assertStaticLabel(bad));
  }
  const holds = { preTapMs: 6000, settledMs: 12000, resultMs: 25000 };
  const good = {
    frames: [{ at: 0, file: 'frames/0.jpg', verdict: 'clean' }, { at: 1, file: null, card: 'Unlock', verdict: 'card' }],
    events: [
      { kind: 'tap', label: 'Tap Send', holdMs: 6000 },
      { kind: 'settled', label: 'Home', holdMs: 12000 },
      { kind: 'result', label: 'Home balances', holdMs: 25000 },
    ],
  };
  assert.deepEqual(verifyTimeline(good, holds), []);
  assert.ok(verifyTimeline({ ...good, events: [{ kind: 'tap', label: 'Tap Send', holdMs: 5999 }] }, holds).length);
  assert.ok(verifyTimeline({ ...good, events: [{ kind: 'result', label: 'Home balances', holdMs: 1000 }] }, holds).length);
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
    this.clicks = [];
  }
  async evaluate(fn) {
    if (fn === hCanarySnapshot) return { text: this.text, values: [] };
    return this.verdicts.length > 1 ? this.verdicts.shift() : (this.verdicts[0] ?? { card: [], mask: [] });
  }
  async screenshot() {
    this.shots++;
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
    assert.ok(adapter.shots - shotsBefore <= 4, 'no screenshots during the scope beyond the resume checks');

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

test('a failed secret scope reports its own error and keeps the card until the screen is clean', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('mask');
  const recorder = new GuardedRecorder({ adapter, lane: 'failure test', outDir: out, canary: makeCanary(), holds: { preTapMs: 50, settledMs: 80, resultMs: 100 }, interval: 20 });
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

test('without masks (Firefox) a mask-level surface becomes a full card', async () => {
  const out = mkdtempSync(join(tmpdir(), 'h-recorder-'));
  const adapter = new FakeAdapter('card');
  const recorder = new GuardedRecorder({ adapter, lane: 'firefox test', outDir: out, canary: makeCanary(), holds: { preTapMs: 50, settledMs: 80, resultMs: 100 }, interval: 20 });
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

test('live H specs act only through the recorder helpers', () => {
  const spec = readFileSync(join(here, '..', 'tests', 'live', 'h-firefox.live.mjs'), 'utf8');
  const offenders = [];
  for (const match of spec.matchAll(/([A-Za-z_$][\w$.]*)\.(click|fill|sendKeys|selectOption|check|type|tap|press|choose)\(/g)) {
    const receiver = match[1];
    if (/(^|\.)footage$/.test(receiver) || receiver === 'ops') continue;
    // Zeroing an array of phrase words is not an interaction.
    if (match[2] === 'fill' && spec.startsWith("'')", match.index + match[0].length)) continue;
    offenders.push(`${receiver}.${match[2]}`);
  }
  assert.deepEqual(offenders, [], 'raw interactions bypass the hold and guard policy');
  assert.equal(/\bsleep\(\s*[1-9]\d{4,}/.test(spec), false, 'holds come from the recorder, not ad hoc sleeps');
});
