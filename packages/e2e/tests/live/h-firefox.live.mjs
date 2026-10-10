#!/usr/bin/env node
/**
 * Area H live lane: the Smirk Wallet v0.3.1 release candidate (run 11204) in
 * Firefox, in Firefox with LibreWolf-style hardening, and in Chromium, with the
 * guarded recorder running throughout.
 *
 * Lanes
 *   firefox      Firefox 156 + geckodriver 0.37.1, staged Firefox zip
 *                (sha256 d1bc2463...) installed temporarily; the moz-extension
 *                UUID is pinned through extensions.webextensions.uuids.
 *   firefox-rfp  The same with resistFingerprinting + letterboxing, WebGL off
 *                and strict tracking protection (LibreWolf defaults). The
 *                measured-layout fallback is the known expected skip there.
 *   chromium     Playwright Chromium with the staged Chrome zip (e64fb7ac...).
 *                It also writes the balance reference the macOS desktop smoke
 *                compares against.
 *
 * Flows per lane, each asserting a real outcome
 *   Import alice (redacted), balances on Home, lock policy "lock every time",
 *   lock and unlock twice, Receive XMR (a valid address), Send to Review
 *   (alice's own address, never submitted), Messages (relay up, no error),
 *   a live swap quote (THORChain, else Trocador; never confirmed), and the
 *   380x600 compact layout with every header button clicked, in the default
 *   theme and in Windows XP. No funds move in this area.
 *
 * Video policy: every operation goes through the recorder's helpers: a 6 s
 * still before each tap, 12 s on every settled screen, 25 s on key results.
 * Secret steps (phrase entry, password entry) record a redaction card instead.
 * Firefox has no screenshot masks, so any password field (the lock screen,
 * Settings' reveal field) cards the whole frame there; Chromium masks it.
 *
 * Gates (each opt-in, all required): E2E_LIVE=1, FOOTAGE=guarded and
 * ALLOW_PROD_WRITES=1 (importing alice signs in to production).
 *
 * Custody: the phrase comes from one NAME=value line of the owner-only (0600)
 * custody file through readWalletPhrase, in this process only. Never `set -a`
 * that file into a shell: every child, including the browsers, would inherit
 * it. jw-laptop does not hold the file; running there needs the owner's
 * custody step (place it once, mode 0600, and remove it after the run).
 *
 * Usage (from the monorepo root, after npm ci):
 *   E2E_LIVE=1 FOOTAGE=guarded ALLOW_PROD_WRITES=1 \
 *   node packages/e2e/tests/live/h-firefox.live.mjs \
 *     --wallet-file <custody file> [--lanes firefox,firefox-rfp,chromium] \
 *     [--staged DIR] [--firefox BIN] [--geckodriver BIN] [--headed] \
 *     [--out DIR] [--font TTF] [--no-encode] [--allow-version-drift]
 *
 * Output (0700): ~/Build/smirk-e2e/v0.3.1-run-11204/footage/H-cross-browser-desktop/<lane>/
 *   timeline.json, frames/, <lane>.mp4, CHAPTERS-<lane>.md, evidence.json
 * Nothing is uploaded or promoted.
 */
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readWalletPhrase } from '../../demo/capture-demo.mjs';
import { ASSETS, FOOTAGE_ROOT, RELEASE, makeCanary } from '../../fixtures/H-cross-browser-desktop-policy.mjs';
import { GuardedRecorder, encodeLane, privateDir } from '../../fixtures/H-cross-browser-desktop-recorder.mjs';
import { hHeaderHitTest } from '../../fixtures/H-cross-browser-desktop-guard.mjs';
import { GeckoSession, WebDriverError, toolVersion } from '../../fixtures/H-cross-browser-desktop-webdriver.mjs';
import { ChromiumAdapter, FirefoxAdapter } from '../../fixtures/H-cross-browser-desktop-adapters.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const AREA_DIR = 'H-cross-browser-desktop';
/** A fixed, well-formed UUID: every Firefox lane serves the wallet at the same origin. */
const PINNED_UUID = '5e1f0a31-0d31-4c1a-9b2e-0b0003101204';
const POPUP = { width: 380, height: 600 };
const EXPECT = { firefox: /^Mozilla Firefox 156\./, geckodriver: /^geckodriver 0\.37\.1\b/ };

const LIBREWOLF_PREFS = {
  'privacy.resistFingerprinting': true,
  'privacy.resistFingerprinting.letterboxing': true,
  'webgl.disabled': true,
  'browser.contentblocking.category': 'strict',
  'privacy.trackingprotection.enabled': true,
  'privacy.trackingprotection.socialtracking.enabled': true,
};

/** Our own failures: static text, safe to print. */
class LaneError extends Error {}
/** A clearly explained skip (for example, the demo wallet lacks funds). */
class Skip extends Error {}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new LaneError(`--${name} needs a value`);
  return value;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** Print a driver failure without its message: call logs can quote typed values. */
function describe(error) {
  if (error instanceof LaneError || error instanceof Skip) return error.message;
  if (error instanceof WebDriverError) return `browser driver refused (${error.code})`;
  return `browser driver error (${error?.name ?? 'unknown'})`;
}

let interrupted = false;

async function until(probe, { timeout = 30_000, every = 500, what }) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (interrupted) throw new LaneError('interrupted');
    try {
      last = await probe();
      if (last) return last;
    } catch { /* page in transition */ }
    await sleep(every);
  }
  throw new LaneError(`timed out waiting for ${what}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const parseAmount = (text) => {
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(String(text ?? ''));
  return match ? Number(match[1].replace(/,/g, '')) : Number.NaN;
};

// ------------------------------------------------------------------ flows --

class Lane {
  constructor(name, { adapter, footage, password, canary, evidence }) {
    this.name = name;
    this.ui = adapter;
    this.footage = footage;
    this.password = password;
    this.canary = canary;
    this.evidence = evidence;
  }

  async step(name, fn, { recover = true } = {}) {
    if (interrupted) throw new LaneError('interrupted');
    const started = Date.now();
    try {
      const detail = await fn();
      this.evidence.steps.push({ name, status: 'pass', ms: Date.now() - started, ...(detail ? { detail } : {}) });
      console.log(`  pass  ${name}`);
    } catch (error) {
      const status = error instanceof Skip ? 'skip' : 'fail';
      this.evidence.steps.push({ name, status, reason: describe(error), ms: Date.now() - started });
      console.log(`  ${status}  ${name}: ${describe(error)}`);
      if (status === 'fail' && !recover) throw new LaneError(`stopping the lane after: ${name}`);
      if (recover) await this.recover().catch(() => {});
    }
  }

  /** Back to an unlocked Home from anywhere: reopen the wallet and unlock if asked. */
  async recover() {
    await this.footage.act('Reopen the wallet', () => this.ui.goto('popup.html'));
    await until(async () => (await this.ui.visible('lockscreen-root')) || (await this.ui.visible('home-total-balance')), { timeout: 60_000, what: 'the wallet to open' });
    if (await this.ui.visible('lockscreen-root')) await this.unlock();
  }

  async tabRoot(tab, label) {
    await this.footage.tap(`nav-tab-${tab}`, label);
    await this.footage.tap(`nav-tab-${tab}`, label);
  }

  async homeLoaded(timeout = 180_000) {
    return until(async () => /\d/.test((await this.ui.text('home-total-balance')) ?? ''), { timeout, what: 'a real balance total on Home' });
  }

  async unlock() {
    await this.footage.secret('Unlock with the password', async (ops) => {
      await until(() => this.ui.visible('lockscreen-password-input'), { what: 'the password field' });
      await ops.fill('lockscreen-password-input', this.password);
      await ops.tap('lockscreen-unlock-btn');
      await until(async () => !(await this.ui.visible('lockscreen-root')), { timeout: 60_000, what: 'the lock screen to close' });
    });
    await this.homeLoaded();
  }

  async importAlice(words) {
    await until(() => this.ui.visible('onboarding-import-btn'), { timeout: 60_000, what: 'the welcome screen' });
    this.footage.chapter('Welcome screen');
    await this.footage.settled('Welcome screen');
    await this.footage.secret('Import alice: phrase and password entry', async (ops) => {
      await ops.tap('onboarding-import-btn');
      await ops.tap('onboarding-import-warning-continue');
      for (let i = 0; i < words.length; i++) await ops.fill(`onboarding-import-word-${i}`, words[i]);
      await ops.tap('onboarding-import-continue');
      // The wizard fails closed until sign-up requirements resolve and then
      // rebuilds the step empty. Retry only that race: other refusals count
      // against the backend's per-wallet restore budget.
      for (let attempt = 0; attempt < 4; attempt++) {
        await until(() => this.ui.visible('onboarding-password-input'), { what: 'the password step' });
        await ops.fill('onboarding-password-input', this.password);
        await ops.fill('onboarding-password-confirm-input', this.password);
        await ops.tap('onboarding-set-password-submit');
        await sleep(3_000);
        if (!(await this.ui.visible('onboarding-set-password-submit'))) break;
        if (!/sign-up requirements/.test(await this.ui.rootText())) throw new LaneError('import refused at the password step');
        await sleep(5_000);
      }
      try {
        await until(() => this.ui.visible('onboarding-setup-finish-btn'), { timeout: 25_000, what: 'the setup step' });
        await ops.tap('onboarding-setup-finish-btn');
      } catch { /* no setup step for this wallet */ }
      await until(() => this.ui.visible('home-total-balance'), { timeout: 90_000, what: 'Home after import' });
    });
    words.fill('');
    await this.homeLoaded();
  }

  async readBalances() {
    const balances = {};
    await until(async () => {
      for (const asset of ASSETS) {
        if (!(await this.ui.visible(`asset-row-${asset}`))) continue;
        const text = ((await this.ui.text(`asset-row-${asset}-balance`)) ?? '').trim();
        if (!/\d/.test(text)) return false;
        balances[asset] = text;
      }
      return Object.keys(balances).length > 0;
    }, { timeout: 300_000, every: 2_000, what: 'every Home asset row to show a balance' });
    return balances;
  }

  async homeBalances() {
    await this.tabRoot('home', 'Open Home');
    const balances = await this.readBalances();
    const missing = ASSETS.filter((asset) => !(asset in balances));
    if (missing.length) throw new LaneError(`Home is missing asset rows: ${missing.join(', ')}`);
    this.evidence.balances = balances;
    await this.footage.settled('Home with balances');
    await this.footage.result('Home balances');
    return { assets: Object.keys(balances).length };
  }

  async lockEveryTime() {
    await this.tabRoot('settings', 'Open Settings');
    await until(() => this.ui.visible('settings-autolock-select'), { what: 'the auto-lock setting' });
    await this.footage.settled('Settings');
    await this.footage.choose('settings-autolock-select', '0', 'Choose lock every time');
    const value = await this.ui.evaluate(() => /** @type {HTMLSelectElement | null} */ (document.querySelector('[data-testid="settings-autolock-select"]'))?.value ?? null);
    if (value !== '0') throw new LaneError('the auto-lock setting did not take "Immediately"');
    await this.footage.settled('Lock every time is set');
  }

  async lockAndUnlock() {
    await this.footage.tap({ aria: 'Lock wallet' }, 'Lock the wallet');
    await until(() => this.ui.visible('lockscreen-root'), { what: 'the lock screen' });
    await this.footage.settled('Lock screen');
    // Lock every time: reopening the wallet asks for the password again.
    for (const round of [1, 2]) {
      await this.footage.act(round === 1 ? 'Reopen the wallet' : 'Reopen the wallet again', () => this.ui.goto('popup.html'));
      await until(() => this.ui.visible('lockscreen-root'), { timeout: 60_000, what: 'the lock screen on reopen' });
      if (await this.ui.visible('home-total-balance')) throw new LaneError('the wallet opened unlocked under lock every time');
      await this.footage.settled('Lock screen after reopening');
      await this.unlock();
      await this.footage.settled('Home after unlock');
      await this.footage.result('Unlocked Home');
    }
  }

  async receiveXmr() {
    await this.tabRoot('home', 'Open Home');
    await this.footage.tap('home-action-receive', 'Tap Receive');
    await until(() => this.ui.visible('receive-asset-xmr'), { what: 'the receive asset picker' });
    await this.footage.tap('receive-asset-xmr', 'Choose Monero');
    const address = await until(async () => {
      const text = ((await this.ui.text('receive-address')) ?? '').trim();
      return /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(text) ? text : null;
    }, { timeout: 60_000, what: 'a valid Monero receive address' });
    this.xmrAddress = address;
    this.evidence.xmrAddressDigest = createHash('sha256').update(address).digest('hex').slice(0, 16);
    await this.footage.settled('Monero receive address');
    await this.footage.result('Receive XMR address');
    return { kind: address.startsWith('8') ? 'subaddress' : 'primary' };
  }

  async sendToReview() {
    if (!this.xmrAddress) throw new Skip('no XMR address from the Receive step');
    await this.tabRoot('home', 'Open Home');
    await this.footage.tap('home-action-send', 'Tap Send');
    await until(async () => (await this.ui.visible('send-asset-xmr')) || (await this.ui.visible('send-address-input')), { what: 'the send wizard' });
    if (await this.ui.visible('send-asset-xmr')) await this.footage.tap('send-asset-xmr', 'Choose Monero');
    await until(() => this.ui.visible('send-address-input'), { what: 'the destination step' });
    await this.footage.type('send-address-input', this.xmrAddress, 'Enter alice own Monero address');
    await until(() => this.ui.enabled('send-address-continue'), { what: 'the destination to validate' });
    await this.footage.tap('send-address-continue', 'Continue to amount');
    await until(() => this.ui.visible('send-amount-input'), { what: 'the amount step' });
    const balanceText = await until(async () => /Balance:\s*([\d.,]+)\s*XMR/i.exec(await this.ui.rootText())?.[1], { what: 'the XMR balance line' });
    const balance = parseAmount(balanceText);
    if (!(balance > 0)) throw new Skip('alice holds no spendable XMR, so the Review step cannot be reached');
    const amount = Math.min(0.0001, balance / 2).toFixed(6);
    await this.footage.type('send-amount-input', amount, 'Enter a small amount');
    await until(() => this.ui.enabled('send-compose-continue'), { what: 'the amount to validate' });
    await this.footage.tap('send-compose-continue', 'Continue to review');
    await until(() => this.ui.visible('send-review-submit'), { timeout: 60_000, what: 'the Review step' });
    const review = await this.ui.rootText();
    if (!/Review/.test(review) || !/Network fee/i.test(review)) throw new LaneError('Review lacks its amount and fee rows');
    if (!review.replace(/\s+/g, '').includes(this.xmrAddress)) throw new LaneError('Review does not show the destination address');
    await this.footage.settled('Send review');
    await this.footage.result('Send review, not submitted');
    await this.tabRoot('home', 'Leave without sending');
    return { submitted: false };
  }

  async messages() {
    await this.tabRoot('inbox', 'Open Inbox');
    await until(() => this.ui.visible('inbox-messages-btn'), { what: 'the Messages entry' });
    await this.footage.tap('inbox-messages-btn', 'Open Messages');
    await until(() => this.ui.visible('messages-screen'), { what: 'the Messages screen' });
    await this.footage.settled('Messages');
    if (await this.ui.visible('messages-relay-off')) throw new LaneError('Messages reports no relay on the production backend');
    if (await this.ui.visible('messages-error')) throw new LaneError('Messages shows an error');
    if (!(await this.ui.visible('dm-text-input'))) throw new LaneError('Messages has no compose field');
    const count = await this.ui.count('message-item');
    if (count > 0 && !((await this.ui.text('message-text')) ?? '').trim()) throw new LaneError('a message renders without text');
    if (count === 0 && !/No messages yet/.test(await this.ui.rootText())) throw new LaneError('Messages shows neither messages nor the empty state');
    this.evidence.messages = count;
    await this.footage.result('Messages rendered');
    return { messages: count };
  }

  async swapQuote() {
    const balances = this.evidence.balances ?? {};
    const candidates = [
      { provider: 'thorchain', from: 'LTC', to: 'BTC' },
      { provider: 'thorchain', from: 'BTC', to: 'LTC' },
      { provider: 'trocador', from: 'XMR', to: 'BTC' },
      { provider: 'trocador', from: 'LTC', to: 'BTC' },
    ];
    let funded = 0;
    for (const candidate of candidates) {
      const held = parseAmount(balances[candidate.from.toLowerCase()]);
      if (!(held > 0)) continue;
      funded++;
      await this.tabRoot('swap', 'Open Swap');
      const row = `swap-provider-${candidate.provider}`;
      if (!(await this.ui.visible(row)) || !(await this.ui.enabled(row))) continue;
      await this.footage.tap(row, candidate.provider === 'thorchain' ? 'Choose THORChain' : 'Choose Trocador');
      if (candidate.provider === 'thorchain' && !(await this.ui.visible('swap-wizard-step'))) {
        // First tap asks THORChain whether it is live; a live row then starts the wizard.
        const live = await until(async () => /Live now:/.test((await this.ui.text(row)) ?? '') || (await this.ui.visible('swap-wizard-step')), { timeout: 45_000, what: 'THORChain availability' }).catch(() => false);
        if (!live) continue;
        if (!(await this.ui.visible('swap-wizard-step'))) await this.footage.tap(row, 'Start a THORChain swap');
      }
      await until(() => this.ui.visible('swap-pair-get-quote'), { what: 'the swap pair step' });
      if (!(await this.ui.visible(`swap-pair-from-${candidate.from}`)) || !(await this.ui.visible(`swap-pair-to-${candidate.to}`))) {
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      await this.footage.tap(`swap-pair-from-${candidate.from}`, 'Choose what to send');
      await this.footage.tap(`swap-pair-to-${candidate.to}`, 'Choose what to receive');
      // A quote moves nothing; half the balance clears provider minimums best.
      await this.footage.type('swap-pair-amount', String(Number((held / 2).toPrecision(6))), 'Enter the amount to quote');
      if (!(await until(() => this.ui.enabled('swap-pair-get-quote'), { timeout: 10_000, what: 'Get quote' }).catch(() => false))) {
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      await this.footage.tap('swap-pair-get-quote', 'Get a live quote');
      const quoted = await until(async () => ((await this.ui.text('swap-wizard-step')) ?? '').startsWith('2/'), { timeout: 90_000, what: 'a quote' }).catch(() => false);
      if (!quoted) {
        await this.footage.settled('Quote refused');
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      const fee = (await this.ui.text('swap-quote-fee')) ?? '';
      const screen = await this.ui.rootText();
      const receive = parseAmount(/You receive \(est\.\)\s*([\d.,]+)/.exec(screen)?.[1]);
      if (!/\d/.test(fee) || !(receive > 0)) throw new LaneError('the quote lacks a fee or a positive estimate');
      if (!(await this.ui.visible('swap-quote-confirm'))) throw new LaneError('the quote has no confirm control');
      this.evidence.swap = { provider: candidate.provider, pair: `${candidate.from}-${candidate.to}`, quoted: true };
      await this.footage.settled('Swap quote');
      await this.footage.result('Live swap quote, not confirmed');
      await this.footage.tap('swap-wizard-cancel', 'Close the quote');
      return this.evidence.swap;
    }
    if (!funded) throw new Skip('alice holds none of BTC, LTC or XMR, so no quote can be requested');
    throw new LaneError('no provider returned a quote for a funded pair');
  }

  /** Every header button: on screen, receives a hit at its centre, and works when clicked. */
  async headerButtons(themeLabel) {
    await this.tabRoot('home', 'Open Home');
    await this.ui.setSize(POPUP.width, POPUP.height);
    const report = await this.ui.evaluate(hHeaderHitTest);
    const layout = { theme: themeLabel, layout: report.layout, bar: report.bar, width: report.width, buttons: report.buttons };
    (this.evidence.layout ??= []).push(layout);
    if (report.layout !== 'popup') {
      if (this.name !== 'firefox-rfp') throw new LaneError(`the ${POPUP.width}px window got the ${report.layout} layout`);
      layout.expectedSkip = 'resistFingerprinting spoofs the measured viewport; the action popup itself passes layout=popup';
    }
    if (report.buttons.length < 4) throw new LaneError('fewer than four header controls are rendered');
    const blocked = report.buttons.filter((button) => !button.onScreen || !button.hit).map((button) => button.label);
    if (blocked.length) throw new LaneError(`header controls off screen or covered: ${blocked.join(', ')}`);
    await this.footage.settled(`Header in the ${themeLabel} theme`);

    // Refresh.
    await this.footage.tap({ aria: 'Refresh balances' }, 'Tap Refresh balances');
    await this.footage.settled('Balances refreshed');
    await this.homeLoaded();
    // Identity switcher opens its list and closes again.
    await this.footage.tap('header-identity-switcher', 'Tap the identity switcher');
    await until(async () => (await this.ui.attribute('header-identity-switcher', 'aria-expanded')) === 'true', { what: 'the identity list' });
    await this.footage.settled('Identity list open');
    await this.footage.press('escape', 'Close the identity list');
    if ((await this.ui.attribute('header-identity-switcher', 'aria-expanded')) === 'true') {
      await this.footage.tap('header-identity-switcher', 'Close the identity list');
    }
    // Open in a browser tab, then in its own window: each opens the wallet elsewhere.
    for (const [aria, label] of [['Open in a browser tab', 'Open in a browser tab'], ['Open in its own window', 'Open in its own window']]) {
      if (!(await this.ui.visible({ aria }))) {
        if (aria === 'Open in its own window' && report.layout !== 'popup') continue;
        throw new LaneError(`the ${aria} control is missing`);
      }
      const before = await this.ui.handles();
      const home = await this.ui.current();
      await this.footage.tap({ aria }, label);
      const opened = await until(async () => (await this.ui.handles()).find((handle) => !before.includes(handle)), { timeout: 20_000, what: 'the new wallet window' });
      // The wallet hands its session over and then tries window.close(); a
      // browser may or may not let a navigated tab close itself.
      await sleep(2_000);
      const originalSurvived = (await this.ui.handles()).includes(home);
      await this.ui.switchTo(opened);
      await until(async () => /popup\.html/.test(await this.ui.url()), { what: 'the wallet in the new window' });
      await until(async () => (await this.ui.visible('app-shell-root')) || (await this.ui.visible('lockscreen-root')), { timeout: 60_000, what: 'the wallet to render in the new window' });
      await this.footage.settled('Wallet in the new window');
      if (originalSurvived) {
        await this.ui.closeCurrent();
        await this.ui.switchTo(home);
      } else {
        // The new window is now the wallet; carry on there at the popup size.
        await this.ui.setSize(POPUP.width, POPUP.height);
      }
      if (await this.ui.visible('lockscreen-root')) await this.unlock();
      await this.tabRoot('home', 'Back to Home');
    }
    // Lock, then unlock.
    await this.footage.tap({ aria: 'Lock wallet' }, 'Tap Lock wallet');
    await until(() => this.ui.visible('lockscreen-root'), { what: 'the lock screen' });
    await this.footage.settled('Locked from the header');
    await this.unlock();
    await this.footage.result(`Header works in the ${themeLabel} theme`);
    return layout.expectedSkip ? { expectedSkip: 'RFP measured layout' } : { buttons: report.buttons.length };
  }

  /**
   * Fundless probe: proves the browser, the staged build, the recorder and the
   * redaction on real UI without a wallet. "Create new wallet" shows a freshly
   * generated phrase, which the guard must turn into a redaction card; Back
   * returns to the welcome screen. Nothing is registered: the wizard never
   * reaches its password step.
   */
  async probe() {
    this.footage.chapter('Fundless probe');
    // Create runs only in a tab (the popup diverts it), so open the tab surface.
    await this.footage.act('Open the wallet as a tab', () => this.ui.goto('popup.html?ctx=tab'));
    await until(() => this.ui.visible('onboarding-create-btn'), { timeout: 60_000, what: 'the welcome screen' });
    await this.footage.settled('Welcome screen');
    await this.footage.tap('onboarding-create-btn', 'Tap Create new wallet');
    await until(() => this.ui.visible('onboarding-create-seed-word-0'), { what: 'the generated phrase screen' });
    await sleep(2_000);
    const last = this.footage.frames.at(-1);
    if (!last || last.verdict !== 'card') throw new LaneError('the generated phrase screen was not redacted');
    await this.footage.settled('Generated phrase, redacted');
    await this.footage.tap({ aria: 'Back' }, 'Go back to the welcome screen');
    await until(() => this.ui.visible('onboarding-create-btn'), { what: 'the welcome screen again' });
    await until(async () => this.footage.frames.at(-1)?.verdict === 'clean', { what: 'recording to resume after the phrase screen' });
    await this.footage.result('Welcome screen again');
    return { redacted: true };
  }

  async theme(id, label) {
    await this.tabRoot('settings', 'Open Settings');
    const target = { css: 'select:has(option[value="winxp"])' };
    await until(() => this.ui.visible(target), { what: 'the theme setting' });
    await this.footage.choose(target, id, label);
    await until(async () => (await this.ui.evaluate(() => document.documentElement.className)).includes(`smirk-theme-${id}`), { what: 'the theme to apply' });
    await this.footage.settled('Theme applied');
  }
}

// ------------------------------------------------------------------ lanes --

async function launchFirefox(lane, options, work) {
  const zip = join(options.staged, RELEASE.firefoxZip.file);
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [RELEASE.geckoId]: PINNED_UUID }),
    'extensions.update.enabled': false,
    'extensions.autoDisableScopes': 0,
    'app.update.auto': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'devtools.console.stdout.content': false,
    'browser.dom.window.dump.enabled': false,
    'marionette.log.level': 'Fatal',
    'remote.log.level': 'Fatal',
    'signon.rememberSignons': false,
    'signon.autofillForms': false,
    'browser.formfill.enable': false,
    ...(lane === 'firefox-rfp' ? LIBREWOLF_PREFS : {}),
  };
  const session = await GeckoSession.start({ geckodriver: options.geckodriver, firefox: options.firefox, prefs, headless: !options.headed, tmpDir: privateDir(join(work, 'tmp')) });
  try {
    const installed = await session.installTemporaryAddon(zip);
    await session.setWindowRect(POPUP.width, POPUP.height);
    const adapter = new FirefoxAdapter(session, `moz-extension://${PINNED_UUID}`);
    await adapter.goto('popup.html');
    const version = await until(() => adapter.evaluate(() => (globalThis.browser ?? globalThis.chrome).runtime.getManifest().version), { timeout: 30_000, what: 'the extension at its pinned UUID' });
    return { adapter, close: () => session.quit(), facts: { installVia: installed.via, uuidPinned: true, extensionVersion: version, browser: toolVersion(options.firefox) } };
  } catch (error) {
    await session.quit();
    throw error;
  }
}

async function launchChromium(options, work) {
  const zip = join(options.staged, RELEASE.chromeZip.file);
  const unpacked = privateDir(join(work, 'extension'));
  const unzip = spawnSync('unzip', ['-q', '-o', zip, '-d', unpacked], { stdio: 'ignore' });
  if (unzip.status !== 0) throw new LaneError('could not unpack the staged Chrome zip');
  const context = await chromium.launchPersistentContext(privateDir(join(work, 'profile')), {
    headless: !options.headed,
    channel: 'chromium',
    viewport: POPUP,
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = context.pages()[0] ?? await context.newPage();
    const adapter = new ChromiumAdapter(context, page, origin);
    await adapter.goto('popup.html');
    const version = await adapter.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest().version);
    const agent = await adapter.evaluate(() => /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? 'unknown');
    return { adapter, close: () => context.close(), facts: { extensionVersion: version, browser: `Chromium ${agent}` } };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function runLane(lane, options) {
  console.log(`H ${lane}${options.probe ? ' (fundless probe)' : ''}`);
  const outDir = privateDir(join(options.out, AREA_DIR, options.probe ? `${lane}-probe` : lane));
  const work = privateDir(join(options.out, '..', 'work', AREA_DIR, lane));
  const evidence = { area: AREA_DIR, lane, release: RELEASE.version, run: RELEASE.run, source: RELEASE.sourceCommit, startedAt: new Date().toISOString(), steps: [] };
  const zip = lane === 'chromium' ? RELEASE.chromeZip : RELEASE.firefoxZip;
  const actual = sha256File(join(options.staged, zip.file));
  if (actual !== zip.sha256) throw new LaneError(`${zip.file} does not match the release hash`);
  evidence.zipSha256 = actual;

  const words = options.probe ? [] : readWalletPhrase(options.walletFile, 'SMOKE_ALICE_MNEMONIC');
  const password = randomBytes(24).toString('base64url');
  const canary = makeCanary({ phraseWords: words, exact: [password] });
  let browser = null;
  let footage = null;
  try {
    browser = lane === 'chromium' ? await launchChromium(options, work) : await launchFirefox(lane, options, work);
    Object.assign(evidence, browser.facts);
    if (browser.facts.extensionVersion !== RELEASE.version) throw new LaneError(`the loaded extension is not ${RELEASE.version}`);
    footage = new GuardedRecorder({ adapter: browser.adapter, lane: options.probe ? `${lane}-probe` : lane, outDir, canary });
    footage.start();
    const flow = new Lane(lane, { adapter: browser.adapter, footage, password, canary, evidence });
    if (options.probe) {
      await flow.step('Fundless probe: welcome, redacted phrase, back', () => flow.probe(), { recover: false });
    } else {
      await flow.step('Import alice (redacted)', () => flow.importAlice(words), { recover: false });
      await flow.step('Home balances', () => flow.homeBalances());
      await flow.step('Lock every time', () => flow.lockEveryTime(), { recover: false });
      await flow.step('Lock and unlock', () => flow.lockAndUnlock(), { recover: false });
      await flow.step('Receive XMR', () => flow.receiveXmr());
      await flow.step('Send to Review', () => flow.sendToReview());
      await flow.step('Messages render', () => flow.messages());
      await flow.step('Swap quote', () => flow.swapQuote());
      await flow.step('Popup layout, default theme', () => flow.headerButtons('default'));
      await flow.step('Switch to Windows XP', () => flow.theme('winxp', 'Choose the Windows XP theme'));
      await flow.step('Popup layout, Windows XP', () => flow.headerButtons('Windows XP'));
      await flow.step('Back to the default theme', () => flow.theme('default', 'Choose the default theme'));
    }
  } catch (error) {
    if (!evidence.steps.some((step) => step.status === 'fail')) evidence.steps.push({ name: 'lane setup', status: 'fail', reason: describe(error) });
    console.log(`  fail  ${describe(error)}`);
  } finally {
    words.fill('');
    if (footage) await footage.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }

  if (footage && !options.noEncode) {
    try {
      const encoded = encodeLane(outDir, { font: options.font });
      evidence.footage = { file: basename(encoded.output), seconds: Math.round(encoded.seconds), bytes: encoded.bytes, chapters: `CHAPTERS-${footage.lane}.md` };
    } catch (error) {
      evidence.footage = { error: error instanceof Error ? error.message.split('\n')[0] : 'encode failed' };
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = evidence.steps.length > 0 && evidence.steps.every((step) => step.status !== 'fail');
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 1), { mode: 0o600 });
  if (lane === 'chromium' && evidence.balances) {
    writeFileSync(join(options.out, AREA_DIR, 'balances-reference.json'), JSON.stringify({ at: evidence.finishedAt, lane, balances: evidence.balances }, null, 1), { mode: 0o600 });
  }
  return evidence;
}

async function main() {
  // Cheap guards first.
  const probe = flag('fundless-probe');
  if (process.env.FOOTAGE !== 'guarded') throw new LaneError('set FOOTAGE=guarded: this lane always records through its guard');
  if (!probe && (process.env.E2E_LIVE !== '1' || process.env.ALLOW_PROD_WRITES !== '1')) {
    throw new LaneError('set E2E_LIVE=1 and ALLOW_PROD_WRITES=1 to import alice into the live area H lane (or pass --fundless-probe)');
  }
  if (process.env.CAPTURE_VIDEO || process.env.MARKETING_SHOTS || process.env.DEBUG || process.env.PWDEBUG) {
    throw new LaneError('CAPTURE_VIDEO, MARKETING_SHOTS, DEBUG and PWDEBUG stay off; this lane records through its guard only');
  }
  const walletFile = argument('wallet-file');
  if (!walletFile && !probe) throw new LaneError('--wallet-file is required (the owner-only custody file)');
  const options = {
    probe,
    walletFile: walletFile ? resolve(walletFile) : null,
    lanes: argument('lanes', 'firefox,firefox-rfp,chromium').split(',').map((lane) => lane.trim()).filter(Boolean),
    staged: resolve(argument('staged', RELEASE.stagedDir)),
    firefox: argument('firefox', 'firefox'),
    geckodriver: argument('geckodriver', 'geckodriver'),
    headed: flag('headed'),
    out: resolve(argument('out', FOOTAGE_ROOT)),
    font: argument('font', undefined),
    noEncode: flag('no-encode'),
  };
  for (const lane of options.lanes) if (!['firefox', 'firefox-rfp', 'chromium'].includes(lane)) throw new LaneError(`unknown lane ${lane}`);
  if (!existsSync(options.staged)) throw new LaneError('the staged release directory is missing');
  if (options.lanes.some((lane) => lane.startsWith('firefox'))) {
    const firefox = toolVersion(options.firefox);
    const gecko = toolVersion(options.geckodriver);
    if (!firefox || !gecko) throw new LaneError('Firefox and geckodriver must both be installed for the Firefox lanes');
    if (!flag('allow-version-drift') && (!EXPECT.firefox.test(firefox) || !EXPECT.geckodriver.test(gecko))) {
      throw new LaneError(`expected Firefox 156 and geckodriver 0.37.1, found ${firefox} and ${gecko}`);
    }
  }
  if (!options.noEncode && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new LaneError('ffmpeg is required to encode footage (or pass --no-encode)');
  // Prove the custody file loads before launching anything, then drop the words.
  if (!probe) readWalletPhrase(options.walletFile, 'SMOKE_ALICE_MNEMONIC').fill('');
  privateDir(options.out);

  const results = [];
  for (const lane of options.lanes) results.push(await runLane(lane, options));
  console.log('');
  for (const result of results) {
    const counts = ['pass', 'skip', 'fail'].map((status) => `${result.steps.filter((step) => step.status === status).length} ${status}`).join(', ');
    console.log(`H ${result.lane}: ${result.ok ? 'OK' : 'FAILED'} (${counts})${result.footage?.file ? `, footage ${result.footage.file}` : ''}`);
  }
  console.log(`Evidence and footage: ${join(options.out, AREA_DIR)}`);
  if (!results.every((result) => result.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('h-firefox.live.mjs')) {
  // First Ctrl-C stops the lane at its next wait and still removes the browser
  // profile; a second one exits at once.
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('interrupted; cleaning up the browser and its profile (Ctrl-C again to exit now)');
    process.exitCode = 130;
  });
  main().catch((error) => {
    console.error(`area H live lane refused: ${describe(error)}`);
    process.exit(1);
  });
}

export { Lane, runLane, here };
