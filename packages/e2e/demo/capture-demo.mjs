#!/usr/bin/env node
/**
 * Secret-free demo capture: store screenshots and a promo screen recording.
 *
 * This is the separate demo-capture lane the e2e README requires. It is not part
 * of the wallet suite and does not relax that suite's capture policy.
 *
 * Boundaries, each enforced below:
 *   - It loads an UNPACKED RELEASE ARTIFACT (--extension-dir), so frames show the
 *     exact bytes users install, not a dev build.
 *   - The disposable demo wallet's phrase is read in-process from one named line
 *     of an owner-only file. It never reaches argv, stdout, a file or a frame.
 *     The password is random per run and never leaves memory.
 *   - Import and unlock happen before any capture. Recording and screenshots
 *     start only once Home is showing; the page's earlier screens are never
 *     captured. If Home is not showing, or the guard finds a secret surface,
 *     capture refuses.
 *   - Before every screenshot, and four times a second while recording, a guard
 *     refuses if a password input, a seed, recovery, backup, export, unlock or
 *     onboarding surface, or nsec-like text is visible. A refusal deletes that
 *     run's frames.
 *   - Output goes to ~/Build/smirk-marketing (machine-local, disposable).
 *     Nothing is promoted to Marketing Media automatically.
 *
 * Usage (from the monorepo root, after `npm ci`):
 *   node packages/e2e/demo/capture-demo.mjs \
 *     --extension-dir ~/Build/smirk-marketing/ext-chrome-0.3.0-run-NNNN \
 *     --wallet-file packages/smoke-tests/secrets/smoke-mnemonics.env \
 *     [--wallet-var SMOKE_ALICE_MNEMONIC] [--out ~/Build/smirk-marketing]
 */
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { secretSurface, PRIVATE_TEXT } from './guard.mjs';

const VIEWPORT = { width: 380, height: 600 };
const SCALE = 2;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

/** Read exactly one NAME=value line from an owner-only file; never print it. */
export function readWalletPhrase(file, variable) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('wallet file must be a regular owner-only (0600) file owned by this user');
  }
  const matches = readFileSync(file, 'utf8').split('\n')
    .map((line) => line.match(new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)))
    .filter(Boolean);
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} assignment in the wallet file`);
  const phrase = matches[0][1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const words = phrase.split(/\s+/);
  if (![12, 24].includes(words.length) || words.some((word) => !/^[a-z]+$/.test(word))) {
    throw new Error(`${variable} is not a 12- or 24-word phrase`);
  }
  return words;
}

async function assertSafe(page, stage) {
  const found = await page.evaluate(secretSurface, PRIVATE_TEXT);
  if (found) throw new Error(`refusing capture at ${stage}: ${found} is visible`);
}

async function settle(page, ms = 1200, patience = 25_000) {
  await page.waitForTimeout(ms);
  await page.locator('#root').filter({ hasText: /Updating…|Loading/ })
    .waitFor({ state: 'detached', timeout: patience }).catch(() => {});
  await page.waitForTimeout(400);
}

async function setUp(context, extensionId, words) {
  // Never recorded: the only page that shows import and password entry.
  const setup = await context.newPage();
  const password = randomBytes(24).toString('base64url');
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await setup.getByTestId('onboarding-import-btn').click();
  await setup.getByTestId('onboarding-import-warning-continue').click();
  for (let i = 0; i < words.length; i++) await setup.getByTestId(`onboarding-import-word-${i}`).fill(words[i]);
  await setup.getByTestId('onboarding-import-continue').click();
  // The wizard fails closed until the backend's sign-up requirements resolve;
  // its retry rebuilds the step with empty fields, so re-enter before each press.
  const submit = setup.getByTestId('onboarding-set-password-submit');
  for (let attempt = 0; attempt < 4; attempt++) {
    await setup.getByTestId('onboarding-password-input').fill(password);
    await setup.getByTestId('onboarding-password-confirm-input').fill(password);
    await submit.click();
    await setup.waitForTimeout(3000);
    if (!(await submit.isVisible().catch(() => false))) break;
    // Retry only the capabilities race. Any other refusal (a rate limit, a
    // failed history check) stops here: each retry would count against the
    // backend's per-wallet restore budget.
    const screen = await setup.locator('#root').innerText();
    if (!/sign-up requirements/.test(screen)) break;
    await setup.waitForTimeout(5_000);
  }
  await setup.getByTestId('onboarding-setup-finish-btn').click({ timeout: 25_000 }).catch(() => {});
  const total = setup.getByTestId('home-total-balance');
  await total.waitFor({ timeout: 90_000 }).catch(async () => {
    // Names only: test IDs identify screens without carrying entered values.
    const ids = await setup.evaluate(() => [...document.querySelectorAll('[data-testid]')]
      .filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.dataset.testid).slice(0, 40));
    // Visible text holds no typed values (those live in input fields). Report it
    // only when no phrase-entry field exists, so a phrase screen never prints.
    const message = ids.some((id) => /import-word|mnemonic|seed/i.test(id)) ? '(withheld on a phrase screen)'
      : (await setup.locator('#root').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`setup did not reach Home; visible test IDs: ${ids.join(', ') || 'none'}; screen text: ${message}`);
  });
  for (let i = 0; i < 90 && !/\d/.test((await total.textContent()) ?? ''); i++) await setup.waitForTimeout(1000);
  if (!/\d/.test((await total.textContent()) ?? '')) throw new Error('demo wallet never loaded a real balance');
  words.fill('');
  return setup;
}

/** Record only this page: a screenshot loop at device pixels. The guard checks
 *  each frame BEFORE it is written; a refusal stops recording immediately. */
async function startRecording(page, frameDir) {
  const frames = [];
  let stopped = false;
  let paused = false;
  let refusal = null;
  const loop = (async () => {
    while (!stopped) {
      if (paused) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      const found = await page.evaluate(secretSurface, PRIVATE_TEXT).catch(() => 'an unreadable page state');
      if (found) { refusal = found; break; }
      const file = join(frameDir, `${String(frames.length).padStart(5, '0')}.jpg`);
      const at = Date.now() / 1000;
      await page.screenshot({ path: file, type: 'jpeg', quality: 92 }).catch(() => null);
      if (existsSync(file)) frames.push({ file, at });
    }
  })();
  return {
    refusal: () => refusal,
    pause() { paused = true; },
    resume() { paused = false; },
    async stop() {
      stopped = true;
      await loop;
      return frames;
    },
  };
}

/** A tab tap restores that tab's last sub-screen; tapping the active tab again
 *  returns to its root (BottomNav). Two taps reach the root from anywhere. */
async function tabRoot(p, id) {
  await p.getByTestId(`nav-tab-${id}`).click();
  await p.getByTestId(`nav-tab-${id}`).click();
}

/** Settings' root carries recovery and password controls, so no frame is taken
 *  there: recording pauses until the target section is showing. */
let recorder = null;
async function settingsSection(p, navId, screenId) {
  recorder?.pause();
  try {
    await tabRoot(p, 'settings');
    await p.getByTestId(navId).click({ timeout: 10_000 });
    await p.getByTestId(screenId).waitFor({ timeout: 20_000 });
    await assertSafe(p, screenId);
  } finally {
    recorder?.resume();
  }
}

const TOUR = [
  // [raw shot name, caption for the promo video, action that reaches it]
  ['01-home-balances', 'Five chains. One wallet.', async (p) => { await tabRoot(p, 'home'); }],
  ['02-receive-xmr', 'Private Monero light wallet', async (p) => {
    await tabRoot(p, 'home');
    await p.getByTestId('home-action-receive').click();
    await p.getByTestId('receive-asset-xmr').click();
    await p.getByTestId('receive-address').waitFor({ timeout: 30_000 });
  }],
  ['03-send-btc', 'Send in four clear steps', async (p) => {
    await tabRoot(p, 'home');
    await p.getByTestId('home-action-send').click();
    // A second visit may resume at the destination step for the chosen asset.
    const btc = p.getByTestId('send-asset-btc');
    await btc.or(p.getByTestId('send-address-input')).first().waitFor({ timeout: 15_000 });
    if (await btc.isVisible()) await btc.click();
    await p.getByTestId('send-address-input').waitFor({ timeout: 15_000 });
  }],
  ['04-swap', 'Swap between chains in the wallet', async (p) => {
    await tabRoot(p, 'swap');
  }],
  ['05-inbox', 'Encrypted messages and tips', async (p) => {
    await tabRoot(p, 'inbox');
  }],
  ['06-nostr-identity', 'A Nostr identity from your seed', async (p) => {
    await settingsSection(p, 'settings-nostr-nav', 'settings-nostr-screen');
  }],
  ['07-self-host-backend', 'Run your own server', async (p) => {
    await settingsSection(p, 'settings-backend-nav', 'backend-picker');
  }],
  ['08-home-return', 'Your keys never leave your device', async (p) => {
    await tabRoot(p, 'home');
  }],
];

function encode(frames, marks, startedAt, outDir, fontFile) {
  // Resample to an exact 30 fps timeline: each output tick shows the latest frame
  // captured at or before it. (Concatenating the raw ~20 ms frames lets ffmpeg
  // round each one up to its image-rate minimum, which stretched the video and
  // slid every caption off its screen.)
  const FPS = 30;
  const tail = 1.5;
  const sequence = join(outDir, 'sequence');
  rmSync(sequence, { recursive: true, force: true });
  mkdirSync(sequence, { mode: 0o700 });
  const ticks = Math.ceil((frames.at(-1).at - startedAt + tail) * FPS);
  for (let tick = 0, index = 0; tick < ticks; tick++) {
    const time = startedAt + tick / FPS;
    while (index + 1 < frames.length && frames[index + 1].at <= time) index++;
    symlinkSync(frames[index].file, join(sequence, `${String(tick).padStart(6, '0')}.jpg`));
  }
  const raw = join(outDir, 'tour-raw.mp4');
  run(['-framerate', String(FPS), '-i', join(sequence, '%06d.jpg'), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '16', raw]);
  rmSync(sequence, { recursive: true, force: true });

  const escape = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "’").replace(/:/g, '\\:');
  const captions = marks.map((mark, i) => {
    const from = Math.max(0, mark.at - startedAt);
    // The last caption holds to the end of the video.
    const to = (marks[i + 1]?.at ?? frames.at(-1).at + tail) - startedAt;
    return { text: escape(mark.caption), from: from.toFixed(2), to: to.toFixed(2) };
  });
  const formats = [
    // Landscape: popup on the right, captions in a left column that ends before it.
    { name: 'promo-1920x1080.mp4', w: 1920, h: 1080, shotH: 900, x: 'W-w-170', textX: 140, textY: '(h-text_h)/2', size: 50 },
    // Vertical: captions above the popup, centred.
    { name: 'promo-1080x1920.mp4', w: 1080, h: 1920, shotH: 1380, x: '(W-w)/2', textX: '(w-text_w)/2', textY: 150, size: 58 },
  ];
  for (const f of formats) {
    const text = captions.map((c) =>
      `drawtext=fontfile='${fontFile}':text='${c.text}':fontcolor=0xffffff:fontsize=${f.size}:x=${f.textX}:y=${f.textY}:enable='between(t,${c.from},${c.to})'`,
    ).join(',');
    const brand = `drawtext=fontfile='${fontFile}':text='smirk.cash':fontcolor=0xf5c542:fontsize=${Math.round(f.size * 0.7)}:x=${f.w === 1920 ? 120 : '(w-text_w)/2'}:y=h-${f.w === 1920 ? 140 : 220}`;
    const graph = `color=c=0x0d0b14:s=${f.w}x${f.h}:r=30[bg];[0:v]scale=-2:${f.shotH}[shot];[bg][shot]overlay=x=${f.x}:y=(H-h)/2:shortest=1,${text},${brand},format=yuv420p`;
    run(['-i', raw, '-filter_complex', graph, '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', join(outDir, f.name)]);
  }
}

function run(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

async function main() {
  const extensionDir = resolve(argument('extension-dir'));
  const walletFile = resolve(argument('wallet-file'));
  const variable = argument('wallet-var', 'SMOKE_ALICE_MNEMONIC');
  const out = resolve(argument('out', join(homedir(), 'Build', 'smirk-marketing')));
  const fontFile = argument('font', '/System/Library/Fonts/Supplemental/Arial Bold.ttf');
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  if (!existsSync(fontFile)) throw new Error('caption font not found; pass --font');
  const words = readWalletPhrase(walletFile, variable);

  const raw = join(out, 'raw', 'popup');
  const video = join(out, 'video', `v${manifest.version}`);
  const frameDir = join(video, 'frames');
  rmSync(frameDir, { recursive: true, force: true });
  for (const dir of [raw, frameDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const context = await chromium.launchPersistentContext('', {
    headless: !process.env.HEADED, channel: 'chromium', viewport: VIEWPORT, deviceScaleFactor: SCALE,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  let recording = null;
  let stage = 'launch';
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    stage = 'setup';
    // The wallet does not share an unlock with a new page (it opens on the lock
    // screen), so capture continues on the setup page. Nothing earlier on that
    // page is recorded: the screencast starts here, after Home is showing.
    const page = await setUp(context, extensionId, words);
    stage = 'reopen';
    await page.getByTestId('home-total-balance').waitFor({ timeout: 30_000 });
    await assertSafe(page, 'reopen');
    // Warm-up, unrecorded: visit every screen once so data is cached and the
    // recorded tour does not sit on refresh spinners.
    stage = 'warm-up';
    for (const [name, , reach] of TOUR) {
      await reach(page);
      await settle(page, 600);
      await assertSafe(page, `warm-up ${name}`);
    }
    await settle(page, 2000);

    recording = await startRecording(page, frameDir);
    recorder = recording;
    const startedAt = Date.now() / 1000;
    const marks = [];
    for (const [name, caption, reach] of TOUR) {
      stage = name;
      await reach(page);
      // The caption starts when its screen arrives, not after it settles.
      marks.push({ caption, at: Date.now() / 1000 });
      await settle(page, 900, 4_000);
      await assertSafe(page, name);
      if (!name.endsWith('-return')) await page.screenshot({ path: join(raw, `${name}.png`) });
      await page.waitForTimeout(2200);
      if (recording.refusal()) throw new Error(`refusing capture during ${name}: ${recording.refusal()} was visible`);
    }
    const frames = await recording.stop();
    recording = null;
    if (frames.length < 10) throw new Error('screencast produced too few frames');
    encode(frames, marks, frames[0].at, video, fontFile);
    if (process.env.DEMO_KEEP_FRAMES) {
      // Diagnostics: frame times and screen arrivals, names and times only.
      writeFileSync(join(video, 'timeline.json'), JSON.stringify({ frames: frames.map((f) => ({ file: f.file.split('/').pop(), at: f.at })), marks }, null, 1));
    } else {
      rmSync(frameDir, { recursive: true, force: true });
    }
    rmSync(join(video, 'frames.txt'), { force: true });
    console.log(`Captured ${TOUR.length - 1} screenshots in ${raw} and promo videos in ${video} from extension ${manifest.version}.`);
  } catch (error) {
    error.message = `${stage}: ${error.message}`;
    if (recording) await recording.stop();
    rmSync(frameDir, { recursive: true, force: true });
    throw error;
  } finally {
    await context.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // First line only: Playwright call logs can quote values typed into fields.
    console.error(`demo capture refused: ${String(error.message).split('\n')[0]}`);
    process.exit(1);
  });
}
