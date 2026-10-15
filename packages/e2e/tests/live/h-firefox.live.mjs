#!/usr/bin/env node
/**
 * Area H live lane: the Smirk Wallet release candidate (fixtures/release-candidate.json) in
 * Firefox, in Firefox with LibreWolf-style hardening, and in Chromium, with the
 * guarded recorder running throughout.
 *
 * Lanes
 *   firefox      Firefox 156 or later + geckodriver 0.37.1, staged Firefox zip
 *                (its pinned SHA-256) installed temporarily; the moz-extension
 *                UUID is pinned through extensions.webextensions.uuids.
 *   firefox-rfp  The same with resistFingerprinting + letterboxing, WebGL off
 *                and strict tracking protection (LibreWolf defaults). The
 *                measured-layout fallback is the known expected skip there.
 *   chromium     Playwright Chromium with the staged Chrome zip (pinned the same way).
 *                Its last step reads Home again and writes the balance
 *                reference the macOS desktop smoke compares against.
 *
 * Flows per lane, each asserting a real outcome (no step is skipped: a funded
 * asset that reads 0 fails, it does not skip)
 *   Import alice (redacted). Home balances, with alice's funded assets (XMR
 *   and WOW by default, --funded to add) above zero. Receive XMR (a valid
 *   address). Send to Review (alice's own address, never submitted). Messages
 *   (relay up, no error). A live swap quote (THORChain, else Trocador; never
 *   confirmed). In the default theme and again in Windows XP: the 380x600
 *   compact layout with every header control on screen and hit-testable, and
 *   each one clicked: Refresh, identity, Open in a browser tab, Open in its
 *   own window, Lock (then unlock). Lock policy: with a 10 minute auto-lock,
 *   leaving and reopening the wallet keeps it unlocked; with "lock every
 *   time" (Immediately), reopening it WITHOUT the header Lock shows the lock
 *   screen. No funds move.
 *
 * Video policy: every operation goes through the recorder's helpers: a 6 s
 * still before each tap, 12 s on every settled screen (the recorder holds one
 * itself if a screen would otherwise be tapped through), 25 s on key results.
 * Secret steps (phrase entry, password entry) record a redaction card instead.
 * Password fields are masked in Chromium and covered by proven opaque boxes in
 * Firefox, so the lock screen and Settings are recorded, not carded.
 *
 * Gates (each opt-in, all required): E2E_LIVE=1, FOOTAGE=guarded and
 * ALLOW_PROD_WRITES=1 (importing alice signs in to production).
 *
 * Sign-in budget: every sign-in runs the backend's check-restore, limited to
 * 30 an hour per IP (RESTORE_IP_THRESHOLD) for all wallets and agents on that
 * IP, areas A to G included. A lane plans about ten (import two, a tab, a
 * window and a Lock in each theme, a reopen and the lock-every-time unlock).
 * Before a lane launches anything it waits (bounded) for other e2e runs on
 * this host to finish and for its planned spend to fit H's share of the hour
 * (the ledger in fixtures/H-cross-browser-desktop-signin.mjs). A refused
 * check is not counted, so on "Rate limited" the lane backs off (5 min, at
 * most 12 times) and retries instead of failing.
 *
 * Custody: the phrase comes from one NAME=value line of the owner-only (0600)
 * custody file through readWalletPhrase, in this process only. Never `set -a`
 * that file into a shell: every child, including the browsers, would inherit
 * it. jw-laptop does not hold the file; running there needs the owner's
 * custody step (place it once, mode 0600, and remove it after the run).
 *
 * Coverage note: "Chrome: all core flows on the staged Chrome zip" belongs to
 * areas A to G, which verify and load the same zip themselves.
 * This lane covers the core flows above on that zip in Chromium, and the same
 * flows on the staged Firefox zip.
 *
 * Usage (from the monorepo root, after npm ci):
 *   E2E_LIVE=1 FOOTAGE=guarded ALLOW_PROD_WRITES=1 \
 *   node packages/e2e/tests/live/h-firefox.live.mjs \
 *     --wallet-file <custody file> [--lanes firefox,firefox-rfp,chromium] \
 *     [--staged DIR] [--firefox BIN] [--geckodriver BIN] [--headed] \
 *     [--out DIR] [--font TTF] [--no-encode] [--allow-version-drift] \
 *     [--funded xmr,wow[,btc,ltc,grin]] [--signin-budget N] [--share-signin-budget]
 *
 * Output (0700), one directory per invocation, never overwritten:
 *   ~/Build/smirk-e2e/v<version>-run-<run>/footage/H-cross-browser-desktop/<UTC stamp>/<lane>/
 *     timeline.json, frames/, <lane>.mp4, CHAPTERS-<lane>.md, evidence.json
 *   .../H-cross-browser-desktop/balances-reference.json (latest Chromium read)
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
import { ALICE_FUNDED, ASSETS, FOOTAGE_ROOT, POLL_MS, RELEASE, makeCanary, runStamp } from '../../fixtures/H-cross-browser-desktop-policy.mjs';
import { FootageError, GuardedRecorder, encodeLane, privateDir } from '../../fixtures/H-cross-browser-desktop-recorder.mjs';
import { hHeaderHitTest } from '../../fixtures/H-cross-browser-desktop-guard.mjs';
import { GeckoSession, WebDriverError, resolveFirefoxBinary, toolVersion } from '../../fixtures/H-cross-browser-desktop-webdriver.mjs';
import { ChromiumAdapter, FirefoxAdapter } from '../../fixtures/H-cross-browser-desktop-adapters.mjs';
import { BudgetError, SIGNIN, SignInLedger, admitLane, pause } from '../../fixtures/H-cross-browser-desktop-signin.mjs';
import { MOVING_TEXT, writeReference } from '../../fixtures/H-cross-browser-desktop-reference.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const AREA_DIR = 'H-cross-browser-desktop';
/** A fixed, well-formed UUID: every Firefox lane serves the wallet at the same origin. */
const PINNED_UUID = '5e1f0a31-0d31-4c1a-9b2e-0b0003101204';
const POPUP = { width: 380, height: 600 };
/**
 * Firefox is a floor, not a pin: release Firefox updates itself, and the lane exists to prove
 * the wallet on the Firefox users have. The version that ran is recorded in each lane's facts.
 * geckodriver stays pinned, because the lane installs it and its protocol changes break sessions.
 */
const FIREFOX_FLOOR = 156;
const EXPECT = { geckodriver: /^geckodriver 0\.37\.1\b/ };
/** @param {string | null} version `firefox --version` output */
const firefoxMajor = (version) => Number(/^Mozilla Firefox (\d+)\./.exec(version ?? '')?.[1] ?? NaN);
const WINDOW_CONTROLS = Object.freeze([['Open in a browser tab', 'Open in a browser tab'], ['Open in its own window', 'Open in its own window']]);

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
  if (error instanceof LaneError || error instanceof FootageError || error instanceof BudgetError) return error.message;
  // Our own text: the error code and the command path, never a body or browser message.
  if (error instanceof WebDriverError) return `browser driver refused (${error.message})`;
  return `browser driver error (${error?.name ?? 'unknown'})`;
}

let interrupted = false;

/**
 * Browser profiles and their processes, by work directory. The normal path
 * closes the browser and removes its directory in runLane's finally; a second
 * Ctrl-C (or an exit that skips the finally) runs these synchronously: kill
 * every process whose command line names the directory (Firefox's -profile,
 * geckodriver's --profile-root, Chromium's --user-data-dir), then delete it.
 */
const profiles = new Map();
function cleanUpProfile(work) {
  spawnSync('pkill', ['-KILL', '-f', work], { stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}
function cleanUpAllProfiles() {
  for (const work of profiles.keys()) {
    try { cleanUpProfile(work); } catch { /* best effort on the way out */ }
  }
  profiles.clear();
}

async function until(probe, { timeout = 30_000, every = POLL_MS, what }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new LaneError('interrupted');
    try {
      const last = await probe();
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

const TICKER = { btc: 'BTC', ltc: 'LTC', xmr: 'XMR', wow: 'WOW', grin: 'GRIN' };

// ------------------------------------------------------------------ flows --

class Lane {
  constructor(name, { adapter, footage, password, canary, evidence, signins, funded }) {
    this.name = name;
    this.ui = adapter;
    this.footage = footage;
    this.password = password;
    this.canary = canary;
    this.evidence = evidence;
    this.signins = signins;
    this.funded = new Set(funded);
    this.backoffs = 0;
    this.reference = null;
  }

  async step(name, fn, { recover = true } = {}) {
    if (interrupted) throw new LaneError('interrupted');
    const started = Date.now();
    try {
      const detail = await fn();
      this.evidence.steps.push({ name, status: 'pass', ms: Date.now() - started, ...(detail ? { detail } : {}) });
      console.log(`  pass  ${name}`);
    } catch (error) {
      this.evidence.steps.push({ name, status: 'fail', reason: describe(error), ms: Date.now() - started });
      console.log(`  fail  ${name}: ${describe(error)}`);
      if (!recover) throw new LaneError(`stopping the lane after: ${name}`);
      await this.recover().catch(() => {});
    }
  }

  /** Back to an unlocked Home from anywhere: reopen the wallet and unlock if asked. */
  async recover() {
    // A failed secret scope leaves its card on until the screen is clean;
    // take it off here so the rest of the lane records again.
    await this.footage.resume().catch(() => false);
    // Reuse an open, unlocked wallet: every unlock spends a sign-in.
    if ((await this.ui.visible('bottom-nav')) && !(await this.ui.visible('lockscreen-root'))) {
      await this.tabRoot('home', 'Back to Home');
      return;
    }
    await this.reopen();
    const state = await until(async () => ((await this.ui.visible('lockscreen-root')) ? 'locked'
      : (await this.ui.visible('bottom-nav')) || (await this.ui.visible('bootstrap-error')) ? 'open' : null), { timeout: 60_000, what: 'the wallet to open' });
    if (state === 'locked') await this.unlock('a recovery');
    else await this.signedIn('a recovery');
  }

  async reopen() {
    await this.footage.act('Reopen the wallet', () => this.ui.goto('popup.html'));
  }

  async tabRoot(tab, label) {
    await this.footage.tap(`nav-tab-${tab}`, label);
    await this.footage.tap(`nav-tab-${tab}`, label);
  }

  /** A total above zero: alice is funded, so "$0.00" or a dash is a regression. */
  async homeLoaded(timeout = 180_000) {
    return until(async () => parseAmount(await this.ui.text('home-total-balance')) > 0, { timeout, what: 'a balance total above zero on Home' });
  }

  /** A refused check is not counted by the backend: wait it out (bounded), then retry. */
  async waitOutRateLimit(where) {
    this.backoffs++;
    this.evidence.rateLimitBackoffs = this.backoffs;
    if (this.backoffs > SIGNIN.maxBackoffs) {
      throw new LaneError(`${where}: the backend still rate-limits sign-ins after ${SIGNIN.maxBackoffs} waits of ${SIGNIN.backoffMs / 60_000} min`);
    }
    console.log(`  wait  ${where}: the backend rate-limited the sign-in (check-restore allows ${SIGNIN.perHour} an hour per IP); waiting ${SIGNIN.backoffMs / 60_000} min (${this.backoffs} of ${SIGNIN.maxBackoffs})`);
    this.footage.chapter('Waiting out the backend sign-in limit');
    if (!(await pause(SIGNIN.backoffMs, () => interrupted))) throw new LaneError('interrupted');
  }

  /**
   * The session is live: the header's Refresh control is back and enabled
   * (it is disabled while a refresh runs and gone when the session failed).
   * A rate-limited sign-in waits and retries; any other failure stops here.
   */
  async signedIn(where) {
    for (;;) {
      const state = await until(async () => {
        if (await this.ui.visible('bootstrap-error')) return 'failed';
        if (await this.ui.enabled({ aria: 'Refresh balances' })) return 'ok';
        if (/rate limited/i.test(await this.ui.rootText())) return 'failed';
        return null;
      }, { timeout: 600_000, what: `the wallet to sign in after ${where}` });
      if (state === 'ok') return;
      const text = await this.ui.rootText().catch(() => '');
      if (!/rate limited/i.test(text)) {
        const needsPassword = await this.ui.visible('bootstrap-error-unlock');
        throw new LaneError(`${where}: the wallet could not sign in${needsPassword ? ' without the password (it asks for an unlock)' : ''}`);
      }
      await this.waitOutRateLimit(where);
      if (await this.ui.visible('bootstrap-error-retry')) {
        await this.footage.tap('bootstrap-error-retry', 'Try the sign-in again');
        this.signins.record(`${where}: retry`);
      } else {
        // Home kept its last balances but lost the session: open it again.
        await this.reopen();
        if (await until(async () => ((await this.ui.visible('lockscreen-root')) ? 'locked' : (await this.ui.visible('bottom-nav')) ? 'open' : null), { timeout: 60_000, what: 'the wallet to reopen' }) === 'locked') {
          await this.unlock(where);
          return;
        }
        this.signins.record(`${where}: reopen`);
      }
    }
  }

  async unlock(where = 'an unlock') {
    await this.footage.secret('Unlock with the password', async (ops) => {
      await until(() => this.ui.visible('lockscreen-password-input'), { what: 'the password field' });
      await ops.fill('lockscreen-password-input', this.password);
      await ops.tap('lockscreen-unlock-btn');
      this.signins.record(where);
      await until(async () => !(await this.ui.visible('lockscreen-root')), { timeout: 60_000, what: 'the lock screen to close' });
    });
    // Unlocking restores the last screen (Settings, say), not Home.
    await until(async () => (await this.ui.visible('bottom-nav')) || (await this.ui.visible('bootstrap-error')), { timeout: 60_000, what: 'the wallet after unlock' });
    await this.signedIn(where);
    if (!(await this.ui.visible('home-total-balance'))) await this.tabRoot('home', 'Back to Home');
    await this.homeLoaded();
  }

  async importAlice(words) {
    await until(() => this.ui.visible('onboarding-import-btn'), { timeout: 60_000, what: 'the welcome screen' });
    this.footage.chapter('Welcome screen');
    await this.footage.settled('Welcome screen');
    let stage = 'open the import wizard';
    await this.footage.secret('Import alice: phrase and password entry', async (ops) => {
      try {
        await this.#importSteps(ops, words, (next) => { stage = next; });
      } catch (error) {
        throw await this.#importFailure(stage, error);
      }
    });
    words.fill('');
    await this.signedIn('the import');
    await this.homeLoaded();
  }

  /** Why the redacted import stopped, without any value from the screen. */
  async #importFailure(stage, error) {
    if (error instanceof LaneError && /rate-limits sign-ins|interrupted/.test(error.message)) return error;
    const text = await this.ui.rootText().catch(() => '');
    if (/rate limited/i.test(text)) {
      return new LaneError(`import stopped at "${stage}": the backend rate-limited the sign-in (check-restore allows ${SIGNIN.perHour} an hour per IP)`);
    }
    const ids = await this.ui.evaluate(() => [...document.querySelectorAll('[data-testid]')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => (element.getAttribute('data-testid') || '').replace(/[0-9a-f]{16,}/g, '<hex>'))
      .slice(0, 25)).catch(() => []);
    return new LaneError(`import stopped at "${stage}" (${describe(error)}); visible test ids: ${ids.join(', ') || 'none'}`);
  }

  async #importSteps(ops, words, at) {
    await ops.tap('onboarding-import-btn');
    at('confirm the import warning');
    await ops.tap('onboarding-import-warning-continue');
    at('enter the phrase');
    for (let i = 0; i < words.length; i++) await ops.fill(`onboarding-import-word-${i}`, words[i]);
    at('submit the phrase');
    await ops.tap('onboarding-import-continue');
    // Registration runs after the password step moves on; a refusal brings the
    // step back with the wizard's reason. A rate limit is waited out; any other
    // refusal stops the import (it could spend the wallet's restore budget).
    const submit = 'onboarding-set-password-submit';
    for (;;) {
      at('set the password');
      await this.#submitPassword(ops);
      at('register with the backend');
      const next = await until(async () => {
        if (await this.ui.visible('onboarding-setup-finish-btn')) return 'finish';
        if (await this.ui.visible('home-total-balance')) return 'home';
        if (await this.ui.visible(submit)) return 'refused';
        return null;
      }, { timeout: 600_000, what: 'the registration to finish' });
      if (next !== 'refused') break;
      if (!/rate limited/i.test(await this.ui.rootText())) throw new LaneError('the backend refused the registration at the password step');
      await this.waitOutRateLimit('the import');
    }
    this.signins.record('import: register');
    at('finish setup');
    if (await this.ui.visible('onboarding-setup-finish-btn')) await ops.tap('onboarding-setup-finish-btn');
    at('reach Home');
    await until(() => this.ui.visible('home-total-balance'), { timeout: 90_000, what: 'Home after import' });
  }

  /**
   * Fill and submit the password step until it moves on. The wizard fails
   * closed until the backend's sign-up requirements resolve and then rebuilds
   * the step empty: that race is retried (four times). A rate limit is waited
   * out. A refusal from the last try stays on screen until the step moves,
   * so after one the step gets 30 s to move before its answer is read.
   */
  async #submitPassword(ops) {
    const submit = 'onboarding-set-password-submit';
    for (let races = 0; races < 4;) {
      await until(() => this.ui.visible('onboarding-password-input'), { what: 'the password step' });
      const stale = /sign-up requirements|rate limited/i.test(await this.ui.rootText());
      await ops.fill('onboarding-password-input', this.password);
      await ops.fill('onboarding-password-confirm-input', this.password);
      await ops.tap(submit);
      if (stale) await until(async () => !(await this.ui.visible(submit)), { timeout: 30_000, what: 'the step to move on' }).catch(() => false);
      const answer = await until(async () => {
        if (!(await this.ui.visible(submit))) return 'moved';
        const text = await this.ui.rootText();
        if (/rate limited/i.test(text)) return 'limited';
        if (/sign-up requirements/.test(text)) return 'not yet';
        return null;
      }, { timeout: 180_000, what: 'the password step to answer' });
      if (answer === 'moved') {
        this.signins.record('import: restore check');
        return;
      }
      if (answer === 'limited') {
        await this.waitOutRateLimit('the import');
        continue;
      }
      races++;
      // The wizard re-reads the requirements and rebuilds the step empty.
      await until(() => this.ui.evaluate(() => /** @type {HTMLInputElement | null} */ (document.querySelector('[data-testid="onboarding-password-input"]'))?.value === ''),
        { timeout: 15_000, what: 'the password step to reset' }).catch(() => false);
    }
    throw new LaneError('the wizard could not read the backend sign-up requirements after four tries');
  }

  /**
   * Every Home row with a number, alice's funded assets above zero, and
   * which rows show funds in motion (pending, sending or locked).
   */
  async readBalances(what) {
    let balances = {};
    let moving = [];
    const read = async () => {
      balances = {};
      moving = [];
      for (const asset of ASSETS) {
        if (!(await this.ui.visible(`asset-row-${asset}`))) continue;
        const text = ((await this.ui.text(`asset-row-${asset}-balance`)) ?? '').trim();
        if (!/\d/.test(text)) return false;
        balances[asset] = text;
        if (MOVING_TEXT.test((await this.ui.text(`asset-row-${asset}`)) ?? '')) moving.push(asset);
      }
      const zero = [...this.funded].filter((asset) => asset in balances && !(parseAmount(balances[asset]) > 0));
      return Object.keys(balances).length > 0 && zero.length === 0;
    };
    try {
      await until(read, { timeout: 300_000, every: 2_000, what });
    } catch (error) {
      const zero = [...this.funded].filter((asset) => asset in balances && !(parseAmount(balances[asset]) > 0));
      if (zero.length) {
        throw new LaneError(`alice's funded ${zero.map((asset) => TICKER[asset]).join(' and ')} read${zero.length === 1 ? 's' : ''} 0 on Home (expected above zero; a 0 here is how the 2026-10-03 LWS outage looked)`);
      }
      throw error;
    }
    const missing = ASSETS.filter((asset) => !(asset in balances));
    if (missing.length) throw new LaneError(`Home is missing asset rows: ${missing.join(', ')}`);
    return { balances, moving };
  }

  async homeBalances() {
    await this.tabRoot('home', 'Open Home');
    const { balances, moving } = await this.readBalances('every Home asset row to show a balance, funded ones above zero');
    this.evidence.balances = balances;
    this.evidence.moving = moving;
    await this.footage.settled('Home with balances');
    await this.footage.result('Home balances');
    return { assets: Object.keys(balances).length, fundedAboveZero: [...this.funded], moving };
  }

  /** Chromium's last step: a fresh Home read for the desktop smoke, with its time. */
  async referenceBalances() {
    await this.tabRoot('home', 'Open Home');
    const { balances, moving } = await this.readBalances('the Home balances for the desktop reference');
    this.reference = { readAt: new Date().toISOString(), balances, moving };
    await this.footage.settled('Home with balances');
    await this.footage.result('Home balances for the desktop reference');
    return { assets: Object.keys(balances).length, moving };
  }

  async receiveXmr() {
    await this.tabRoot('home', 'Open Home');
    await this.footage.tap('home-action-receive', 'Tap Receive');
    await until(() => this.ui.visible('receive-asset-xmr'), { what: 'the receive asset picker' });
    await this.footage.settled('Receive asset picker');
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
    if (!this.xmrAddress) throw new LaneError('no XMR address from the Receive step to send to');
    await this.tabRoot('home', 'Open Home');
    await this.footage.tap('home-action-send', 'Tap Send');
    await until(async () => (await this.ui.visible('send-asset-xmr')) || (await this.ui.visible('send-address-input')), { what: 'the send wizard' });
    if (await this.ui.visible('send-asset-xmr')) {
      await this.footage.settled('Send asset picker');
      await this.footage.tap('send-asset-xmr', 'Choose Monero');
    }
    await until(() => this.ui.visible('send-address-input'), { what: 'the destination step' });
    await this.footage.settled('Send destination step');
    await this.footage.type('send-address-input', this.xmrAddress, 'Enter alice own Monero address');
    await until(() => this.ui.enabled('send-address-continue'), { what: 'the destination to validate' });
    await this.footage.settled('Destination entered');
    await this.footage.tap('send-address-continue', 'Continue to amount');
    await until(() => this.ui.visible('send-amount-input'), { what: 'the amount step' });
    const balanceText = await until(async () => /Balance:\s*([\d.,]+)\s*XMR/i.exec(await this.ui.rootText())?.[1], { what: 'the XMR balance line' });
    const balance = parseAmount(balanceText);
    if (!(balance > 0)) throw new LaneError('the amount step shows alice\'s XMR as 0; she holds about 0.19 XMR, so this is a balance regression');
    await this.footage.settled('Send amount step');
    const amount = Math.min(0.0001, balance / 2).toFixed(6);
    await this.footage.type('send-amount-input', amount, 'Enter a small amount');
    await until(() => this.ui.enabled('send-compose-continue'), { what: 'the amount to validate' });
    await this.footage.settled('Amount entered');
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
    await this.footage.settled('Inbox');
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

  /** Public tickers of the swap pills on screen, for a refusal's evidence. */
  async #offered(row) {
    return this.ui.evaluate((prefix) => [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => (element.getAttribute('data-testid') || '').slice(prefix.length).replace(/[^A-Z]/g, ''))
      .slice(0, 12), `swap-pair-${row}-`).catch(() => []);
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
      const attempt = { provider: candidate.provider, pair: `${candidate.from}-${candidate.to}` };
      (this.evidence.swapAttempts ??= []).push(attempt);
      await this.tabRoot('swap', 'Open Swap');
      const row = `swap-provider-${candidate.provider}`;
      if (!(await this.ui.visible(row)) || !(await this.ui.enabled(row))) {
        attempt.outcome = 'provider not offered';
        continue;
      }
      await this.footage.settled('Swap providers');
      await this.footage.tap(row, candidate.provider === 'thorchain' ? 'Choose THORChain' : 'Choose Trocador');
      if (candidate.provider === 'thorchain' && !(await this.ui.visible('swap-wizard-step'))) {
        // First tap asks THORChain whether it is live; a live row then starts the wizard.
        const live = await until(async () => /Live now:/.test((await this.ui.text(row)) ?? '') || (await this.ui.visible('swap-wizard-step')), { timeout: 45_000, what: 'THORChain availability' }).catch(() => false);
        if (!live) {
          attempt.outcome = 'THORChain not live';
          continue;
        }
        if (!(await this.ui.visible('swap-wizard-step'))) {
          await this.footage.settled('THORChain is live');
          await this.footage.tap(row, 'Start a THORChain swap');
        }
      }
      await until(() => this.ui.visible('swap-pair-get-quote'), { what: 'the swap pair step' });
      await this.footage.settled('Swap pair step');
      // The provider's asset list can arrive after the step renders.
      if (!(await until(() => this.ui.visible(`swap-pair-from-${candidate.from}`), { timeout: 15_000, what: 'the send asset' }).catch(() => false))) {
        attempt.outcome = `send asset not offered (offered: ${(await this.#offered('from')).join(' ') || 'none'})`;
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      // The To row leaves out the asset chosen in From, so choose From first.
      await this.footage.tap(`swap-pair-from-${candidate.from}`, 'Choose what to send');
      if (!(await until(() => this.ui.visible(`swap-pair-to-${candidate.to}`), { timeout: 15_000, what: 'the receive asset' }).catch(() => false))) {
        attempt.outcome = `receive asset not offered (offered: ${(await this.#offered('to')).join(' ') || 'none'})`;
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      await this.footage.settled('Send asset chosen');
      await this.footage.tap(`swap-pair-to-${candidate.to}`, 'Choose what to receive');
      await this.footage.settled('Receive asset chosen');
      // A quote moves nothing; half the balance clears provider minimums best.
      // At most 8 decimals: BTC and LTC refuse finer amounts.
      const half = (Math.floor((held / 2) * 1e8) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      await this.footage.type('swap-pair-amount', half, 'Enter the amount to quote');
      if (!(await until(() => this.ui.enabled('swap-pair-get-quote'), { timeout: 10_000, what: 'Get quote' }).catch(() => false))) {
        attempt.outcome = 'Get quote stayed disabled';
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      await this.footage.settled('Amount to quote entered');
      await this.footage.tap('swap-pair-get-quote', 'Get a live quote');
      const quoted = await until(async () => ((await this.ui.text('swap-wizard-step')) ?? '').startsWith('2/'), { timeout: 90_000, what: 'a quote' }).catch(() => false);
      if (!quoted) {
        // The provider's refusal as the UI words it (public text, no values).
        const said = (await this.ui.rootText()).split('\n').find((line) => /minimum|too small|too low|insufficient|failed|error|unavailable|refused|limit|not supported/i.test(line));
        attempt.outcome = `quote refused${said ? `: ${said.trim().slice(0, 140)}` : ''}`;
        await this.footage.settled('Quote refused');
        await this.footage.tap('swap-wizard-cancel', 'Cancel this pair');
        continue;
      }
      attempt.outcome = 'quoted';
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
    if (!funded) throw new LaneError('Home shows none of BTC, LTC or XMR above zero, so no quote can be requested; alice holds XMR, so this is a balance regression');
    throw new LaneError('no provider returned a quote for a funded pair');
  }

  /**
   * The wallet opened elsewhere from a header control: a tab or its own
   * window. The new window signs in from the handed-over session; the
   * original hands over and then tries window.close(), which a browser may
   * or may not honour.
   */
  async #openElsewhere(aria, label) {
    const before = await this.ui.handles();
    const home = await this.ui.current();
    await this.footage.tap({ aria }, label);
    this.signins.record(label);
    const opened = await until(async () => (await this.ui.handles()).find((handle) => !before.includes(handle)), { timeout: 20_000, what: 'the new wallet window' });
    await this.ui.switchTo(opened);
    await until(async () => /popup\.html/.test(await this.ui.url()), { what: 'the wallet in the new window' });
    await until(async () => (await this.ui.visible('app-shell-root')) || (await this.ui.visible('lockscreen-root')) || (await this.ui.visible('bootstrap-error')),
      { timeout: 60_000, what: 'the wallet to render in the new window' });
    // By the time the new window renders, the original has closed itself or it stays.
    const originalClosed = await until(async () => !(await this.ui.handles()).includes(home), { timeout: 5_000, what: 'the original window to close' }).catch(() => false);
    if (await this.ui.visible('lockscreen-root')) await this.unlock(`${label}: the new window`);
    else await this.signedIn(`${label}: the new window`);
    await this.footage.settled('Wallet in the new window');
    (this.evidence.handoffs ??= []).push({ control: aria, originalClosed: Boolean(originalClosed) });
    if (!originalClosed) {
      await this.ui.closeCurrent();
      await this.ui.switchTo(home);
    } else {
      // The new window is now the wallet; carry on there at the popup size.
      await this.ui.setSize(POPUP.width, POPUP.height);
    }
    await this.tabRoot('home', 'Back to Home');
  }

  /** The header Lock control: the lock screen, then unlock. */
  async #lockFromHeader() {
    await this.footage.tap({ aria: 'Lock wallet' }, 'Tap Lock wallet in the header');
    await until(() => this.ui.visible('lockscreen-root'), { what: 'the lock screen' });
    if (await this.ui.visible('home-total-balance')) throw new LaneError('Lock wallet left Home on screen');
    await this.footage.settled('Lock screen');
    await this.unlock('the header Lock');
    await this.footage.settled('Home after unlock');
  }

  /**
   * Every header button: on screen, receives a hit at its centre, and works
   * when clicked, in this theme: Refresh, the identity switcher, Open in a
   * browser tab, Open in its own window, and Lock.
   */
  async headerButtons(themeLabel) {
    await this.tabRoot('home', 'Open Home');
    await this.ui.setSize(POPUP.width, POPUP.height);
    // The identity chip and Refresh render only with a live session.
    await this.signedIn(`the header in the ${themeLabel} theme`);
    const report = await this.ui.evaluate(hHeaderHitTest);
    const layout = { theme: themeLabel, layout: report.layout, bar: report.bar, width: report.width, buttons: report.buttons };
    (this.evidence.layout ??= []).push(layout);
    if (report.layout !== 'popup') {
      if (this.name !== 'firefox-rfp') throw new LaneError(`the ${POPUP.width}px window got the ${report.layout} layout`);
      layout.expectedSkip = 'resistFingerprinting spoofs the measured viewport; the action popup itself passes layout=popup';
    }
    if (report.buttons.length < 4) throw new LaneError(`only ${report.buttons.length} header controls are rendered (${report.buttons.map((button) => button.label).join(', ') || 'none'})`);
    const blocked = report.buttons.filter((button) => !button.onScreen || !button.hit).map((button) => button.label);
    if (blocked.length) throw new LaneError(`header controls off screen or covered: ${blocked.join(', ')}`);
    for (const label of ['Refresh balances', 'Lock wallet', ...(report.layout === 'popup' ? WINDOW_CONTROLS.map(([aria]) => aria) : [])]) {
      if (!report.buttons.some((button) => button.label === label)) throw new LaneError(`the ${label} control is missing`);
    }
    await this.footage.settled(`Header in the ${themeLabel} theme`);

    const clicked = [];
    // Refresh: disabled while it runs, enabled again when it finishes.
    await this.footage.tap({ aria: 'Refresh balances' }, 'Tap Refresh balances');
    await this.signedIn('a refresh');
    await this.homeLoaded();
    await this.footage.settled('Balances refreshed');
    clicked.push('Refresh balances');
    // Identity switcher opens its list and closes again.
    await this.footage.tap('header-identity-switcher', 'Tap the identity switcher');
    await until(async () => (await this.ui.attribute('header-identity-switcher', 'aria-expanded')) === 'true', { what: 'the identity list' });
    await this.footage.settled('Identity list open');
    await this.footage.press('escape', 'Close the identity list');
    if ((await this.ui.attribute('header-identity-switcher', 'aria-expanded')) === 'true') {
      await this.footage.tap('header-identity-switcher', 'Close the identity list');
    }
    await until(async () => (await this.ui.attribute('header-identity-switcher', 'aria-expanded')) !== 'true', { what: 'the identity list to close' });
    clicked.push('Switch identity');
    // Open in a browser tab, then in its own window: each opens the wallet elsewhere.
    for (const [aria, label] of WINDOW_CONTROLS) {
      if (!(await this.ui.visible({ aria }))) {
        if (aria === 'Open in its own window' && report.layout !== 'popup') continue;
        throw new LaneError(`the ${aria} control is missing`);
      }
      await this.#openElsewhere(aria, label);
      clicked.push(aria);
    }
    // Lock, then unlock.
    await this.#lockFromHeader();
    clicked.push('Lock wallet');
    await this.footage.result(`Header works in the ${themeLabel} theme`);
    return { ...(layout.expectedSkip ? { expectedSkip: 'RFP measured layout' } : {}), buttons: report.buttons.length, clicked };
  }

  async #setAutoLock(value, label, settledLabel) {
    await this.tabRoot('settings', 'Open Settings');
    await until(() => this.ui.visible('settings-autolock-select'), { what: 'the auto-lock setting' });
    await this.footage.settled('Settings');
    await this.footage.choose('settings-autolock-select', value, label);
    const now = await this.ui.evaluate(() => /** @type {HTMLSelectElement | null} */ (document.querySelector('[data-testid="settings-autolock-select"]'))?.value ?? null);
    if (now !== value) throw new LaneError(`the auto-lock setting did not take ${value === '0' ? 'Immediately' : `${value} minutes`}`);
    await this.footage.settled(settledLabel);
  }

  /** Reopen without the header Lock and report what the wallet shows. */
  async #reopenState() {
    await this.tabRoot('home', 'Leave Settings');
    await this.reopen();
    return until(async () => ((await this.ui.visible('lockscreen-root')) ? 'locked'
      : (await this.ui.visible('bottom-nav')) || (await this.ui.visible('bootstrap-error')) ? 'open' : null), { timeout: 60_000, what: 'the wallet to reopen' });
  }

  /**
   * Lock policy without the header Lock. A 10 minute auto-lock first: leaving
   * and reopening the wallet must keep it unlocked (so a lock screen later is
   * the policy's doing, not the reopen's). Then "Immediately" (lock every
   * time): leaving and reopening must show the lock screen by itself.
   */
  async lockEveryTime() {
    await this.#setAutoLock('10', 'Choose a 10 minute auto-lock', 'Auto-lock is 10 minutes');
    if (await this.#reopenState() === 'locked') throw new LaneError('the wallet locked on reopen under a 10 minute auto-lock');
    this.signins.record('reopen under a 10 minute auto-lock');
    await this.signedIn('a reopen under a 10 minute auto-lock');
    await this.homeLoaded();
    await this.footage.settled('Reopened, still unlocked');
    await this.footage.result('A 10 minute auto-lock keeps the wallet open');

    await this.#setAutoLock('0', 'Choose lock every time', 'Lock every time is set');
    if (await this.#reopenState() !== 'locked') throw new LaneError('the wallet reopened unlocked under lock every time');
    if (await this.ui.visible('home-total-balance')) throw new LaneError('the wallet showed Home under lock every time');
    await this.footage.settled('Lock screen after reopening');
    await this.footage.result('Lock every time locked the wallet on reopen');
    await this.unlock('the lock every time unlock');
    await this.footage.settled('Home after unlock');
    return { tenMinutesReopen: 'unlocked', immediatelyReopen: 'locked' };
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
    await until(async () => this.footage.frames.at(-1)?.verdict === 'card', { timeout: 10_000, what: 'the recorder to card the generated phrase' })
      .catch(() => { throw new LaneError('the generated phrase screen was not redacted'); });
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
    await this.footage.settled('Settings');
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
    // The phrase is typed into plain text inputs: session restore must never
    // write form data into the profile, and nothing is kept for a crash restore.
    'browser.sessionstore.privacy_level': 2,
    'browser.sessionstore.resume_from_crash': false,
    'browser.sessionstore.max_tabs_undo': 0,
    'browser.sessionstore.max_windows_undo': 0,
    'browser.cache.disk.enable': false,
    ...(lane === 'firefox-rfp' ? LIBREWOLF_PREFS : {}),
  };
  // systemAccess: Firefox refuses scripts in moz-extension pages without it (see the driver).
  const session = await GeckoSession.start({ geckodriver: options.geckodriver, firefox: options.firefoxBinary, prefs, headless: !options.headed, tmpDir: privateDir(join(work, 'tmp')), systemAccess: true });
  try {
    const installed = await session.installTemporaryAddon(zip);
    // A fresh install opens the setup tab; it is the way in when classic
    // WebDriver will not navigate a content tab to moz-extension://.
    await until(async () => (await session.handles()).length > 1, { timeout: 20_000, what: 'the setup tab' }).catch(() => {});
    const adapter = new FirefoxAdapter(session, `moz-extension://${PINNED_UUID}`);
    await adapter.goto('popup.html');
    await adapter.setSize(POPUP.width, POPUP.height);
    const version = await until(() => adapter.evaluate(() => (globalThis.browser ?? globalThis.chrome).runtime.getManifest().version), { timeout: 30_000, what: 'the extension at its pinned UUID' });
    return { adapter, close: () => session.quit(), facts: { installVia: installed.via, uuidPinned: true, extensionVersion: version, browser: toolVersion(options.firefox), exclusiveSession: true } };
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
  const laneDir = options.probe ? `${lane}-probe` : lane;
  const outDir = privateDir(join(options.out, AREA_DIR, options.stamp, laneDir));
  const work = join(options.out, '..', 'work', AREA_DIR, `${laneDir}-${options.stamp}`);
  const evidence = {
    area: AREA_DIR, lane, release: RELEASE.version, run: RELEASE.run, source: RELEASE.sourceCommit, runStamp: options.stamp,
    startedAt: new Date().toISOString(), funded: options.probe ? [] : options.funded, steps: [],
  };
  const zip = lane === 'chromium' ? RELEASE.chromeZip : RELEASE.firefoxZip;
  const actual = sha256File(join(options.staged, zip.file));
  if (actual !== zip.sha256) throw new LaneError(`${zip.file} does not match the release hash`);
  evidence.zipSha256 = actual;

  const signins = new SignInLedger(options.ledger, { lane, budget: options.signinBudget });
  let browser = null;
  let footage = null;
  let flow = null;
  let words = [];
  try {
    // Cheap first: wait (bounded) for other e2e runs and for the budget, before any browser.
    if (!options.probe) {
      const waited = await admitLane(signins, SIGNIN.plan.browserLane, {
        shareBudget: options.shareBudget,
        stop: () => interrupted,
        say: (line) => console.log(`  wait  ${line}`),
      });
      evidence.signinPreflight = { planned: SIGNIN.plan.browserLane, budget: signins.budget, usedAtStart: signins.used().length, waitedMs: waited };
    }
    words = options.probe ? [] : readWalletPhrase(options.walletFile, 'SMOKE_ALICE_MNEMONIC');
    const password = randomBytes(24).toString('base64url');
    const canary = makeCanary({ phraseWords: words, exact: [password] });
    profiles.set(privateDir(work), true);
    browser = lane === 'chromium' ? await launchChromium(options, work) : await launchFirefox(lane, options, work);
    Object.assign(evidence, browser.facts);
    if (browser.facts.extensionVersion !== RELEASE.version) throw new LaneError(`the loaded extension is not ${RELEASE.version}`);
    footage = new GuardedRecorder({ adapter: browser.adapter, lane: laneDir, outDir, canary });
    footage.start();
    flow = new Lane(lane, { adapter: browser.adapter, footage, password, canary, evidence, signins, funded: options.funded });
    if (options.probe) {
      await flow.step('Fundless probe: welcome, redacted phrase, back', () => flow.probe(), { recover: false });
    } else {
      await flow.step('Import alice (redacted)', () => flow.importAlice(words), { recover: false });
      await flow.step('Home balances, funded assets above zero', () => flow.homeBalances());
      await flow.step('Receive XMR', () => flow.receiveXmr());
      await flow.step('Send to Review', () => flow.sendToReview());
      await flow.step('Messages render', () => flow.messages());
      await flow.step('Swap quote', () => flow.swapQuote());
      await flow.step('Popup layout and every header control clicked, default theme', () => flow.headerButtons('default'));
      await flow.step('Switch to Windows XP', () => flow.theme('winxp', 'Choose the Windows XP theme'));
      await flow.step('Popup layout and every header control clicked, Windows XP', () => flow.headerButtons('Windows XP'));
      await flow.step('Lock every time locks on reopen; a 10 minute auto-lock does not', () => flow.lockEveryTime());
      await flow.step('Back to the default theme', () => flow.theme('default', 'Choose the default theme'));
      if (lane === 'chromium') await flow.step('Home balances for the desktop reference', () => flow.referenceBalances());
    }
  } catch (error) {
    if (!evidence.steps.some((step) => step.status === 'fail')) evidence.steps.push({ name: 'lane setup', status: 'fail', reason: describe(error) });
    console.log(`  fail  ${describe(error)}`);
  } finally {
    words.fill('');
    if (footage) await footage.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (profiles.has(work)) {
      cleanUpProfile(work);
      profiles.delete(work);
    }
  }
  evidence.signinsRecorded = signins.entries().filter((entry) => entry.lane === lane && Date.parse(evidence.startedAt) <= entry.at).length;
  if (footage) evidence.recorder = footage.stats;

  if (footage && !options.noEncode) {
    try {
      const encoded = encodeLane(outDir, { font: options.font });
      evidence.footage = { file: basename(encoded.output), seconds: Math.round(encoded.seconds), bytes: encoded.bytes, chapters: `CHAPTERS-${footage.lane}.md` };
    } catch (error) {
      evidence.footage = { error: error instanceof Error ? error.message.split('\n')[0] : 'encode failed' };
    }
  }
  evidence.finishedAt = new Date().toISOString();
  // Every step must pass: there are no skips to count as OK.
  evidence.ok = evidence.steps.length > 0 && evidence.steps.every((step) => step.status === 'pass');
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 1), { mode: 0o600 });
  const referenceStep = evidence.steps.find((step) => step.name === 'Home balances for the desktop reference');
  if (lane === 'chromium' && flow?.reference && referenceStep?.status === 'pass') {
    const reference = { area: AREA_DIR, lane, runStamp: options.stamp, ...flow.reference };
    writeReference(join(options.out, AREA_DIR, options.stamp, 'balances-reference.json'), reference);
    writeReference(join(options.out, AREA_DIR, 'balances-reference.json'), reference);
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
  const out = resolve(argument('out', FOOTAGE_ROOT));
  const options = {
    probe,
    walletFile: walletFile ? resolve(walletFile) : null,
    lanes: argument('lanes', 'firefox,firefox-rfp,chromium').split(',').map((lane) => lane.trim()).filter(Boolean),
    staged: resolve(argument('staged', RELEASE.stagedDir)),
    firefox: argument('firefox', 'firefox'),
    geckodriver: argument('geckodriver', 'geckodriver'),
    headed: flag('headed'),
    out,
    font: argument('font', undefined),
    noEncode: flag('no-encode'),
    funded: [...new Set(argument('funded', ALICE_FUNDED.join(',')).split(',').map((asset) => asset.trim().toLowerCase()).filter(Boolean))],
    signinBudget: Number(argument('signin-budget', String(SIGNIN.budget))),
    shareBudget: flag('share-signin-budget'),
    ledger: join(out, AREA_DIR, 'signin-ledger.jsonl'),
    stamp: runStamp(),
  };
  for (const lane of options.lanes) if (!['firefox', 'firefox-rfp', 'chromium'].includes(lane)) throw new LaneError(`unknown lane ${lane}`);
  for (const asset of options.funded) if (!ASSETS.includes(asset)) throw new LaneError(`--funded: unknown asset ${asset}`);
  if (!Number.isInteger(options.signinBudget) || options.signinBudget < SIGNIN.plan.browserLane || options.signinBudget > SIGNIN.perHour) {
    throw new LaneError(`--signin-budget must be a whole number from ${SIGNIN.plan.browserLane} (one lane's plan) to ${SIGNIN.perHour} (the backend's limit)`);
  }
  if (!existsSync(options.staged)) throw new LaneError('the staged release directory is missing');
  if (options.lanes.some((lane) => lane.startsWith('firefox'))) {
    const firefox = toolVersion(options.firefox);
    const gecko = toolVersion(options.geckodriver);
    if (!firefox || !gecko) throw new LaneError('Firefox and geckodriver must both be installed for the Firefox lanes');
    if (!flag('allow-version-drift') && (!(firefoxMajor(firefox) >= FIREFOX_FLOOR) || !EXPECT.geckodriver.test(gecko))) {
      throw new LaneError(`expected Firefox ${FIREFOX_FLOOR} or later and geckodriver 0.37.1, found ${firefox} and ${gecko}`);
    }
    options.firefoxBinary = resolveFirefoxBinary(options.firefox);
    if (!options.firefoxBinary) throw new LaneError('could not find the Firefox executable behind its launcher; pass --firefox with its path');
  }
  if (!options.noEncode && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new LaneError('ffmpeg is required to encode footage (or pass --no-encode)');
  // Prove the custody file loads before launching anything, then drop the words.
  if (!probe) readWalletPhrase(options.walletFile, 'SMOKE_ALICE_MNEMONIC').fill('');
  privateDir(join(options.out, AREA_DIR));

  const results = [];
  for (const lane of options.lanes) results.push(await runLane(lane, options));
  console.log('');
  for (const result of results) {
    const counts = ['pass', 'fail'].map((status) => `${result.steps.filter((step) => step.status === status).length} ${status}`).join(', ');
    console.log(`H ${result.lane}: ${result.ok ? 'OK' : 'FAILED'} (${counts})${result.footage?.file ? `, footage ${result.footage.file}` : ''}`);
  }
  console.log(`Evidence and footage: ${join(options.out, AREA_DIR, options.stamp)}`);
  if (!results.every((result) => result.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('h-firefox.live.mjs')) {
  // First Ctrl-C stops the lane at its next wait and still removes the browser
  // profile; a second one kills the browsers, removes their profiles and exits.
  process.on('SIGINT', () => {
    if (interrupted) {
      cleanUpAllProfiles();
      process.exit(130);
    }
    interrupted = true;
    console.error('interrupted; cleaning up the browser and its profile (Ctrl-C again to stop now, still removing the profile)');
    process.exitCode = 130;
  });
  // Any exit that skips runLane's finally still removes the profiles.
  process.on('exit', cleanUpAllProfiles);
  main().catch((error) => {
    console.error(`area H live lane refused: ${describe(error)}`);
    process.exit(1);
  });
}

export { Lane, runLane, here };
