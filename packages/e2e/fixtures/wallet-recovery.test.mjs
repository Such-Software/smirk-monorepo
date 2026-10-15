// A reopened wallet goes back to Home's root from any restored screen, within
// its budget, and says what it found, without reading anything but test ids.
// Run: node --import tsx --test packages/e2e/fixtures/wallet-recovery.test.mjs
//
// The page is a small stand-in for the popup, with the real test ids and the
// real navigation rules: a tap on the active tab returns to its root, a tap on
// another tab restores that tab's last screen, wizard state outlives the
// route (core/src/state/route.ts and wizards.ts), Back on step 0 of Send is
// Cancel (SendWizard.tsx), and a finished screen closes with its own control.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { WalletRecoveryError, recoverToHome, waitForHome } from './wallet-recovery.ts';
import { noteStep, privateContext, takeRecoveries } from './failure-context.ts';

const CLAIM_LINK = 'https://smirk.cash/tip/9f1c2a7e#k=Zq8vT3mW0pLr5sXy2bN4cD6fH8jK1aQe';
const SCREEN_SECRET = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

const FAKE_POPUP = String.raw`<!doctype html><html><body><div id="root"></div><script>
const S = window.__state;
window.__pressed = [];
const tabOf = (route) => route.split('/')[0];
const go = (route) => { S.remembered[tabOf(route)] = route; S.route = route; render(); };
const press = (id) => { window.__pressed.push(id); };
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'onclick') node.addEventListener('click', v); else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
function button(id, text, onclick) { return el('button', { 'data-testid': id, onclick: () => { press(id); onclick(); } }, text); }
function send() {
  S.send ??= { step: 0, grin: false };
  const back = button('send-wizard-header-back', S.send.step === 0 ? 'Cancel' : 'Back', () => {
    if (S.send.step === 0) { S.send = null; go('home'); } else { S.send.step--; render(); }
  });
  const step = S.send.step;
  if (step >= 4) return el('div', {}, el('span', { 'data-testid': 'send-done-txid' }, 'ab'.repeat(32)), button('send-done-close', 'Done', () => { S.send = null; go('home'); }));
  const body = step === 0 ? button('send-asset-btc', 'BTC', () => { S.send.step = 1; render(); })
    : step === 1 ? el('div', {}, el('input', { 'data-testid': 'send-address-input' }), button('send-address-continue', 'Continue', () => {}))
    : step === 2 ? el('div', {}, el('input', { 'data-testid': 'send-amount-input' }), button('send-compose-continue', 'Continue to review', () => {}))
    : S.send.grin ? el('div', {}, el('span', { 'data-testid': 'send-review-usd' }, '$1'), el('textarea', {}, 'slatepack'))
    : el('div', {}, el('span', { 'data-testid': 'send-review-usd' }, '$1'), button('send-review-submit', 'Send', () => { S.sent = true; }));
  return el('div', {}, back, body);
}
function main() {
  const r = S.route;
  if (r === 'home') return el('div', {}, el('div', { 'data-testid': 'home-total-balance' }, '$12.34'), button('home-action-send', 'Send', () => go('home/send')));
  if (r === 'home/send') return send();
  if (r === 'home/tip') return el('div', {}, el('h2', { 'data-testid': 'tip-success-heading' }, 'Tip link created'),
    el('div', { 'data-testid': 'tip-share-url' }, ${JSON.stringify(CLAIM_LINK)}), button('tip-success-done-btn', 'Done', () => go('home')));
  if (r === 'home/asset/btc') return el('div', {}, button('asset-detail-back', 'Back', () => go('home')), el('div', { 'data-testid': 'asset-detail-balance' }, '0.1 BTC'));
  if (r === 'settings') return button('settings-lock-now-btn', 'Lock now', () => {});
  if (r === 'settings/backend') return el('div', { 'data-testid': 'settings-backend-screen' }, button('backend-reset-default', 'Reset', () => { S.backendReset = true; }));
  if (r === 'swap') return S.swap
    ? el('div', {}, el('span', { 'data-testid': 'swap-wizard-step' }, 'Deposit'), button('swap-wizard-back', 'Back', () => { S.swapBack = true; }), button('swap-wizard-cancel', 'Cancel', () => { S.swap = false; S.swapCancelled = true; render(); }))
    : el('div', { 'data-testid': 'swap-tab' }, 'Swap');
  if (r === 'stuck') return el('div', { 'data-testid': 'mystery-screen' }, ${JSON.stringify(SCREEN_SECRET)});
  return el('div', {}, 'unknown');
}
function dialog() {
  if (S.dialog === 'tx') return el('div', { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'tx-detail-sheet', style: 'position:fixed;inset:0;background:#0008' },
    button('tx-detail-close', 'Close', () => { S.dialog = null; render(); }));
  if (S.dialog === 'op') return el('form', { role: 'dialog', 'aria-modal': 'true', style: 'position:fixed;inset:0;background:#000c' },
    el('input', { type: 'password', 'data-testid': 'operation-password' }), button('operation-password-confirm', 'Confirm', () => {}));
  return '';
}
function render() {
  const root = document.getElementById('root');
  root.replaceChildren();
  if (S.loadingForever) { root.append(el('div', {}, 'Loading…')); return; }
  if (S.locked) { root.append(el('div', { 'data-testid': 'lockscreen-root' }, el('input', { type: 'password', 'data-testid': 'lockscreen-password-input' }), button('lockscreen-unlock-btn', 'Unlock', () => {}))); return; }
  const nav = el('nav', { 'data-testid': 'bottom-nav' }, ...['home', 'swap', 'inbox', 'settings'].map((t) => button('nav-tab-' + t, t, () => {
    if (S.navBroken) return;
    if (tabOf(S.route) === t && S.route !== t) go(t); else go(S.remembered[t] ?? t);
  })));
  root.append(el('div', { 'data-testid': 'app-shell-root' }, el('header', { 'data-testid': 'app-shell-header' }, 'Smirk'), el('main', {}, main()), nav), dialog());
}
// A restored route that replaces the first screen a moment later, as the
// popup's session-state load does after unlock (ui/src/state/hooks.tsx).
if (S.restoreLater) setTimeout(() => { const to = S.restoreLater.to; S.restoreLater = null; go(to); }, S.restoreLater.afterMs);
// A sign-in that shows nothing for a while (proof of work, a rescan).
if (S.loadingForMs) { S.loadingForever = true; setTimeout(() => { S.loadingForever = false; render(); }, S.loadingForMs); }
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && S.dialog) { press('Escape'); S.dialog = null; render(); }
});
render();
</script></body></html>`;

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

/** A page showing the stand-in popup in `state`; returns the page and a reader of its state. */
async function popup(state) {
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  const full = { route: 'home', remembered: {}, send: null, locked: false, dialog: null, ...state };
  full.remembered[full.route.split('/')[0]] ??= full.route;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setContent(FAKE_POPUP.replace('<div id="root"></div>', `<div id="root"></div><script>window.__state = ${JSON.stringify(full)};</script>`));
  assert.deepEqual(errors, [], 'the stand-in popup rendered');
  return { page, read: () => page.evaluate(() => ({ state: window.__state, pressed: window.__pressed })) };
}

const NEVER = ['send-review-submit', 'swap-wizard-cancel', 'swap-wizard-back', 'backend-reset-default', 'operation-password-confirm', 'lockscreen-unlock-btn'];
function assertOnlyNavigation(pressed) {
  for (const id of NEVER) assert.equal(pressed.includes(id), false, `recovery pressed ${id}`);
}

test('a wallet that opens on Home needs no move and reports nothing', async () => {
  const { page } = await popup({});
  const report = await recoverToHome(page, { wallet: 'alice' });
  assert.equal(report.reached, 'home');
  assert.equal(report.from, null);
  assert.deepEqual(report.moves, []);
  await page.close();
});

test('a Send draft restored on Review is backed out step by step and discarded', async () => {
  const { page, read } = await popup({ route: 'home/send', send: { step: 3, grin: false } });
  const report = await recoverToHome(page, { wallet: 'alice' });
  assert.equal(report.reached, 'home');
  assert.ok(report.from.includes('send-review-submit'), `from names the Review screen: ${report.from}`);
  assert.ok(report.moves.length >= 4 && report.moves.every((m) => m === 'step back out of the send draft'), report.moves.join(', '));
  const { state, pressed } = await read();
  assert.equal(state.send, null, 'the draft is gone, so the next Send starts fresh');
  assert.equal(state.sent, undefined);
  assertOnlyNavigation(pressed);
  await page.close();
});

test('a finished tip result closes with its own control, and its claim link is never read', async () => {
  const { page } = await popup({ route: 'home/tip' });
  const report = await recoverToHome(page, { wallet: 'bob' });
  assert.equal(report.reached, 'home');
  assert.deepEqual(report.moves, ['close the tip result']);
  assert.ok(report.from.includes('tip-share-url'));
  assert.equal(JSON.stringify(report).includes('Zq8vT3mW'), false, 'the report carries no screen text');
  await page.close();
});

test('an open sheet closes, and a password prompt is dismissed, never answered', async () => {
  const sheet = await popup({ dialog: 'tx' });
  const closed = await recoverToHome(sheet.page, { wallet: 'carol' });
  assert.equal(closed.reached, 'home');
  assert.deepEqual(closed.moves, ['close the transaction sheet']);
  await sheet.page.close();

  const prompt = await popup({ route: 'home/send', send: { step: 3, grin: false }, dialog: 'op' });
  await prompt.page.getByTestId('operation-password').focus();
  const dismissed = await recoverToHome(prompt.page, { wallet: 'carol' });
  assert.equal(dismissed.reached, 'home');
  assert.equal(dismissed.moves[0], 'dismiss the dialog');
  const { pressed } = await prompt.read();
  assertOnlyNavigation(pressed);
  await prompt.page.close();
});

test('a Send step that may hold funds in flight is left in place, and Home is reached by its tab', async () => {
  const { page, read } = await popup({ route: 'home/send', send: { step: 3, grin: true } });
  const report = await recoverToHome(page, { wallet: 'alice' });
  assert.equal(report.reached, 'home');
  assert.deepEqual(report.moves, ['tap the Home tab']);
  assert.match(report.kept ?? '', /send in progress/);
  const { state } = await read();
  assert.deepEqual(state.send, { step: 3, grin: true }, 'the exchange state is kept');
  await page.close();
});

test('another tab restores Home last screen first, and that is handled too', async () => {
  const { page, read } = await popup({ route: 'settings/backend', remembered: { home: 'home/send' }, send: { step: 1, grin: false } });
  const report = await recoverToHome(page, { wallet: 'bob' });
  assert.equal(report.reached, 'home');
  assert.equal(report.moves[0], 'tap the Home tab');
  assert.ok(report.from.includes('settings-backend-screen'));
  const { state, pressed } = await read();
  assert.equal(state.send, null);
  assert.equal(state.backendReset, undefined, 'a setting is never changed');
  assertOnlyNavigation(pressed);
  await page.close();
});

test('a swap in progress is never cancelled: the Home tab leaves it', async () => {
  const { page, read } = await popup({ route: 'swap', swap: true });
  const report = await recoverToHome(page, { wallet: 'alice' });
  assert.equal(report.reached, 'home');
  assert.match(report.kept ?? '', /swap in progress/);
  const { state, pressed } = await read();
  assert.equal(state.swap, true);
  assertOnlyNavigation(pressed);
  await page.close();
});

test('the lock screen is handed back at once, without a move', async () => {
  const { page } = await popup({ route: 'home/send', send: { step: 3, grin: false }, locked: true });
  const report = await recoverToHome(page, { wallet: 'carol' });
  assert.equal(report.reached, 'locked');
  assert.deepEqual(report.moves, []);
  await page.close();
});

test('a screen with no way Home fails within its budget, naming the screen by test ids only', async () => {
  const { page } = await popup({ route: 'stuck', navBroken: true });
  const started = Date.now();
  await assert.rejects(recoverToHome(page, { wallet: 'alice', budgetMs: 3_000 }), (error) => {
    assert.ok(error instanceof WalletRecoveryError);
    assert.equal(error.name, 'WalletRecoveryError');
    assert.equal(error.reason, 'stuck');
    assert.match(error.message, /mystery-screen/);
    assert.equal(error.message.includes('abandon'), false, 'no screen text in the error');
    return true;
  });
  assert.ok(Date.now() - started < 3_000 + 7_000, `gave up in ${Date.now() - started} ms`);
  await page.close();
});

test('a popup that never shows a wallet screen fails within the first-paint budget', async () => {
  const { page } = await popup({ loadingForever: true });
  const started = Date.now();
  await assert.rejects(recoverToHome(page, { wallet: 'bob', firstPaintMs: 1_500 }), (error) => error.reason === 'no-surface');
  assert.ok(Date.now() - started < 1_500 + 2_000);
  await page.close();
});

test('a failed recovery is noted as failed, with where it started', async () => {
  takeRecoveries();
  const { page } = await popup({ route: 'stuck', navBroken: true });
  await assert.rejects(recoverToHome(page, { wallet: 'alice', budgetMs: 500 }));
  const [noted] = takeRecoveries();
  assert.equal(noted.failed, true);
  assert.equal(noted.reached, undefined);
  assert.ok(noted.from.includes('mystery-screen'));
  await page.close();
});

test('a recorded lane taps through its own helper, and the failure log keeps the recovery, shaped', async () => {
  takeRecoveries();
  const { page } = await popup({ route: 'home/asset/btc' });
  const taps = [];
  const report = await recoverToHome(page, {
    wallet: 'carol',
    tap: async (target, label) => {
      taps.push(label);
      await target.click();
    },
  });
  assert.equal(report.reached, 'home');
  assert.deepEqual(taps, ['back from the coin screen']);
  // The recovery is noted for the next record, and a failure shows the step that ran.
  noteStep(`tap ${CLAIM_LINK}`);
  const context = await privateContext({ errors: [{ message: `locator.click: Timeout 5000ms exceeded. ${SCREEN_SECRET}`, stack: 'TimeoutError: x\n    at f (/x/packages/e2e/fixtures/C-tips-live.ts:220:5)' }], status: 'failed', expectedStatus: 'passed' });
  assert.deepEqual(context.recoveries.map((r) => [r.wallet, r.reached, r.moves]), [['carol', 'home', ['back from the coin screen']]]);
  assert.equal(context.errors[0].name, 'TimeoutError');
  assert.equal(context.errors[0].at, 'C-tips-live.ts:220');
  assert.equal(context.steps.at(-1).label, 'label withheld');
  const text = JSON.stringify(context);
  for (const secret of ['Zq8vT3mW', 'abandon', '9f1c2a7e']) assert.equal(text.includes(secret), false, secret);
  await page.close();
});

test('a Home that the restored route replaces a moment later is not taken for Home', async () => {
  // 2026-10-14, lane B: carol's unlock painted Home, then her restored BTC coin
  // screen; one look returned 'home' and the lane waited 10 minutes there.
  takeRecoveries();
  const { page } = await popup({ route: 'home', remembered: { home: 'home/asset/btc' }, restoreLater: { to: 'home/asset/btc', afterMs: 800 } });
  const report = await recoverToHome(page, { wallet: 'carol' });
  assert.equal(report.reached, 'home');
  assert.ok(report.moves.length >= 1, 'a move was made to leave the restored screen');
  assert.ok(report.from?.includes('asset-detail-back'), `from names the restored screen: ${report.from}`);
  assert.equal(await page.getByTestId('home-total-balance').isVisible(), true, 'Home is what the page shows when recovery returns');
  assert.equal(takeRecoveries().length, 1, 'the recovery is noted');
  await page.close();
});

test('a wait for Home brings back a restored screen that shows after a slow sign-in, well within its budget', async () => {
  takeRecoveries();
  const { page } = await popup({ route: 'home/asset/btc', loadingForMs: 1_500 });
  const started = Date.now();
  const reached = await waitForHome(page, { wallet: 'carol', timeoutMs: 10 * 60_000 });
  assert.equal(reached, true);
  assert.ok(Date.now() - started < 20_000, `reached Home in ${Date.now() - started} ms`);
  assert.equal(await page.getByTestId('home-total-balance').isVisible(), true);
  const noted = takeRecoveries();
  assert.ok(noted.some((r) => r.reached === 'home' && r.moves.length > 0), 'the move back is noted');
  await page.close();
});

test('a wait for Home that never comes returns false at its budget, and a screen with no way back stops early', async () => {
  const loading = await popup({ loadingForever: true });
  let started = Date.now();
  assert.equal(await waitForHome(loading.page, { wallet: 'bob', timeoutMs: 2_000 }), false);
  assert.ok(Date.now() - started < 2_000 + 3_000, `gave up in ${Date.now() - started} ms`);
  await loading.page.close();

  takeRecoveries();
  const stuck = await popup({ route: 'stuck', navBroken: true });
  started = Date.now();
  assert.equal(await waitForHome(stuck.page, { wallet: 'bob', timeoutMs: 10 * 60_000, budgetMs: 500, maxRecoveries: 1 }), false);
  assert.ok(Date.now() - started < 30_000, `gave up in ${Date.now() - started} ms, not at the 10 min budget`);
  assert.ok(takeRecoveries().every((r) => r.failed), 'each attempt is noted as failed');
  await stuck.page.close();
});
