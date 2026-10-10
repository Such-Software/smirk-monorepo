#!/usr/bin/env node
/**
 * Area H macOS desktop driver, run by scripts/desktop-smoke-macos.sh after it
 * has verified the disk image and copied the signed app into the run's private
 * directory. Do not run it directly; the shell script owns the cheap guards,
 * the signature checks and the isolation proof.
 *
 * Modes
 *   --probe   launch with the scratch HOME, require the fresh welcome screen
 *             (an installed wallet would show its lock screen), quit. No wallet.
 *   (default) the recorded flow: import alice with recording stopped, Home
 *             balances read from the accessibility tree and compared with the
 *             Chromium reference, lock and unlock with recording stopped around
 *             the password, a history entry, its explorer link opening the
 *             default browser (verified out of frame), quit.
 *
 * The app runs with HOME, CFFIXED_USER_HOME and TMPDIR pointed at the scratch
 * home, so its store and web data land there, not in the user's Library.
 *
 * Recording: ffmpeg avfoundation records only the app window's rectangle, and
 * only while the app is frontmost and the accessibility guard is clean. A
 * watchdog stops and DELETES a segment the moment a guard label appears or
 * another app comes to the front. Secret steps run with recording stopped and
 * a redaction card in the timeline.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readWalletPhrase } from '../demo/capture-demo.mjs';
import { ASSETS, HOLDS, RELEASE, assertStaticLabel, makeCanary, verifyTimeline } from '../fixtures/H-cross-browser-desktop-policy.mjs';
import { drawLines, ffmpeg, filterScriptArgs, findFont, privateDir, wrapLines } from '../fixtures/H-cross-browser-desktop-recorder.mjs';

const WINDOW = { x: 60, y: 60, w: 1024, h: 720 };
const NAMES = { btc: 'Bitcoin', ltc: 'Litecoin', xmr: 'Monero', wow: 'Wownero', grin: 'Grin' };
const TICKERS = { btc: 'BTC', ltc: 'LTC', xmr: 'XMR', wow: 'WOW', grin: 'GRIN' };

class SmokeError extends Error {}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new SmokeError(`--${name} needs a value`);
  return value;
}

/** Run the AX helper. `input` (a secret) goes to stdin, never argv. */
function ax(binary, args, input) {
  const result = spawnSync(binary, args.map(String), { encoding: 'utf8', input: input ?? '', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !result.stdout) throw new SmokeError(`accessibility helper failed (${args[0]})`);
  try {
    const parsed = JSON.parse(String(result.stdout).trim().split('\n').at(-1));
    if (parsed.error) throw new SmokeError(`accessibility helper: ${parsed.error}`);
    return parsed;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError(`accessibility helper returned no JSON (${args[0]})`);
  }
}

async function until(probe, { timeout = 30_000, every = 750, what }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch { /* app in transition */ }
    await sleep(every);
  }
  throw new SmokeError(`timed out waiting for ${what}`);
}

const amount = (text) => {
  const match = /(\d[\d,]*(?:\.\d+)?)/.exec(String(text ?? ''));
  return match ? Number(match[1].replace(/,/g, '')) : Number.NaN;
};

/** Default https handler from LaunchServices; Safari when none is set. */
function defaultBrowser() {
  const plist = join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  try {
    const parsed = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
    const handler = (parsed.LSHandlers ?? []).find((entry) => entry.LSHandlerURLScheme === 'https');
    if (handler?.LSHandlerRoleAll) return handler.LSHandlerRoleAll.toLowerCase();
  } catch { /* fall through */ }
  return 'com.apple.safari';
}

class Desktop {
  constructor({ axBinary, app, home }) {
    this.axBinary = axBinary;
    this.app = app;
    this.home = home;
    this.child = null;
    this.pid = 0;
  }

  ax(...args) { return ax(this.axBinary, args); }
  axSecret(args, secret) { return ax(this.axBinary, args, secret); }

  async launch() {
    const binary = join(this.app, 'Contents', 'MacOS', 'smirk-desktop');
    if (!existsSync(binary)) throw new SmokeError('the copied app has no smirk-desktop binary');
    privateDir(join(this.home, 'tmp'));
    this.child = spawn(binary, [], {
      stdio: 'ignore',
      env: { HOME: this.home, CFFIXED_USER_HOME: this.home, TMPDIR: join(this.home, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
    });
    this.pid = this.child.pid;
    await until(() => this.ax('window', this.pid).found, { timeout: 60_000, what: 'the app window' });
    this.ax('place', this.pid, WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h);
    this.ax('activate', this.pid);
    await sleep(1_500);
  }

  snapshot() { return this.ax('snapshot', this.pid); }
  frontmost() { return this.ax('frontmost').pid === this.pid; }
  hasText(pattern) {
    const shot = this.snapshot();
    return !shot.guard && shot.texts.some((value) => pattern.test(value));
  }

  hasButton(pattern) {
    const shot = this.snapshot();
    return !shot.guard && shot.buttons.some((label) => pattern.test(label));
  }

  press(role, pattern, nth = 0) {
    const result = this.ax('press', this.pid, role, pattern, nth);
    if (!result.ok) throw new SmokeError(`no ${role === 'any' ? 'control' : role} matching ${pattern}`);
  }

  async quit() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    for (let i = 0; i < 50 && this.child.exitCode === null; i++) await sleep(100);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

/** Window-only screen recording in guarded segments, with cards between them. */
class SegmentRecorder {
  constructor({ desktop, outDir, screenIndex, canary, holds = HOLDS }) {
    this.desktop = desktop;
    this.outDir = privateDir(outDir);
    this.segmentDir = privateDir(join(outDir, 'segments'));
    this.screenIndex = screenIndex;
    this.canary = canary;
    this.holds = holds;
    this.entries = [];
    this.events = [];
    this.current = null;
    this.startedAt = null;
    this.crop = null;
  }

  clean() {
    if (!this.desktop.frontmost()) return 'Another app in front';
    const shot = this.desktop.snapshot();
    if (!shot.window) return 'No window';
    if (shot.guard) return shot.guard;
    return this.canary.check({ text: shot.texts.join(' '), values: [] });
  }

  cropFor() {
    const scale = this.desktop.ax('scale').scale;
    const win = this.desktop.ax('window', this.desktop.pid);
    const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
    return { w: even(win.w * scale), h: even(win.h * scale), x: even(win.x * scale), y: even(win.y * scale) };
  }

  card(label) {
    assertStaticLabel(label);
    this.startedAt ??= Date.now();
    const last = this.entries.at(-1);
    if (last?.kind === 'card' && last.label === label) return;
    this.entries.push({ kind: 'card', label, start: Date.now() });
  }

  async start(label) {
    assertStaticLabel(label);
    if (this.current) return;
    const verdict = this.clean();
    if (verdict) return this.card(verdict);
    this.crop ??= this.cropFor();
    const file = join(this.segmentDir, `${String(this.entries.length).padStart(4, '0')}.mp4`);
    const { w, h, x, y } = this.crop;
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '30',
      '-i', `${this.screenIndex}:none`, '-vf', `crop=${w}:${h}:${x}:${y}`, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', file],
    { stdio: ['pipe', 'ignore', 'ignore'] });
    this.startedAt ??= Date.now();
    const entry = { kind: 'segment', label, file, start: Date.now(), discarded: false };
    this.current = { child, entry, watching: true };
    this.entries.push(entry);
    // Watchdog: a guard label or a foreign window ends and deletes the segment.
    this.current.watch = (async () => {
      while (this.current?.entry === entry && this.current.watching) {
        const verdict = (() => { try { return this.clean(); } catch { return 'Screen unreadable'; } })();
        if (verdict && this.current?.entry === entry) {
          await this.#discard(verdict);
          return;
        }
        await sleep(400);
      }
    })();
  }

  async #discard(reason) {
    const { child, entry } = this.current;
    this.current = null;
    child.kill('SIGKILL');
    await new Promise((done) => (child.exitCode !== null ? done() : child.once('exit', done)));
    rmSync(entry.file, { force: true });
    entry.discarded = true;
    entry.kind = 'card';
    entry.label = 'Recording stopped by the guard';
    this.card(reason);
  }

  async stop() {
    if (!this.current) return;
    const { child, entry } = this.current;
    this.current.watching = false;
    await this.current.watch;
    if (this.current?.entry !== entry) return;
    this.current = null;
    child.stdin.write('q');
    child.stdin.end();
    await new Promise((done) => (child.exitCode !== null ? done() : child.once('exit', done)));
    entry.end = Date.now();
    if (!existsSync(entry.file) || statSync(entry.file).size < 1024) {
      entry.kind = 'card';
      entry.label = 'Recording unavailable';
    }
  }

  async #still(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) await sleep(Math.min(250, ms - (Date.now() - start)) || 1);
  }

  async tap(label, action) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await action();
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  async settled(label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.settledMs);
    this.events.push({ kind: 'settled', label, start, end: Date.now(), holdMs: Date.now() - start });
  }

  async result(label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.resultMs);
    this.events.push({ kind: 'result', label, start, end: Date.now(), holdMs: Date.now() - start });
  }

  /** Recording stopped and a card shown while fn runs; resumes after two clean passes. */
  async secret(label, fn, resumeLabel) {
    assertStaticLabel(label);
    await this.stop();
    const start = Date.now();
    this.card(label);
    try {
      await fn();
    } finally {
      let clean = 0;
      const deadline = Date.now() + 120_000;
      while (clean < 2) {
        let verdict;
        try { verdict = this.clean(); } catch { verdict = 'Screen unreadable'; }
        clean = verdict ? 0 : clean + 1;
        if (clean < 2) {
          if (Date.now() > deadline) throw new SmokeError(`a secret surface stayed visible after: ${label}`);
          await sleep(500);
        }
      }
      this.events.push({ kind: 'secret', label, start, end: Date.now(), holdMs: Date.now() - start });
    }
    if (resumeLabel) await this.start(resumeLabel);
  }

  async finish() {
    await this.stop();
    const stoppedAt = Date.now();
    const timeline = { area: 'H-cross-browser-desktop', lane: 'macos-desktop', startedAt: this.startedAt, stoppedAt, crop: this.crop, entries: this.entries, events: this.events };
    writeFileSync(join(this.outDir, 'timeline.json'), JSON.stringify(timeline, null, 1), { mode: 0o600 });
    return timeline;
  }
}

/** Compose segments and cards at real speed on a 1920x1080 canvas with captions and a UTC clock. */
function encodeDesktop(outDir, timeline, fontOption) {
  const problems = verifyTimeline({ events: timeline.events, frames: [] });
  if (problems.length) throw new SmokeError(`refusing to encode: ${[...new Set(problems)].join('; ')}`);
  if (!timeline.crop) throw new SmokeError('refusing to encode: nothing was recorded');
  const font = findFont(fontOption);
  const work = privateDir(join(outDir, 'encode'));
  const { w, h } = timeline.crop;
  const clips = [];
  timeline.entries.forEach((entry, i) => {
    const until = timeline.entries[i + 1]?.start ?? timeline.stoppedAt;
    const seconds = Math.max(0.5, (until - entry.start) / 1000);
    if (entry.kind === 'segment') {
      clips.push(entry.file);
      return;
    }
    const clip = join(work, `card-${i}.mp4`);
    const text = [
      ...drawLines({ font, lines: ['Redacted'], size: Math.round(h / 12), color: '0xf5c542', x: '(w-text_w)/2', y: `h/2-${Math.round(h / 6)}`, workDir: work, stem: `card-${i}-title` }),
      ...drawLines({ font, lines: [...wrapLines(entry.label, 40), '', 'Nothing secret is recorded here.'], size: Math.round(h / 26), color: '0xffffff', x: '(w-text_w)/2', y: 'h/2', workDir: work, stem: `card-${i}-body` }),
    ];
    ffmpeg(['-f', 'lavfi', '-i', `color=c=0x15121f:s=${w}x${h}:r=30:d=${seconds.toFixed(3)}`,
      '-vf', text.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', clip]);
    clips.push(clip);
  });
  const t0 = timeline.entries[0].start;
  const marks = timeline.events.map((event) => ({ at: event.start, label: event.label })).sort((a, b) => a.at - b.at);
  const duration = (timeline.stoppedAt - t0) / 1000;
  const captions = marks.flatMap((mark, i) => {
    const from = Math.max(0, (mark.at - t0) / 1000);
    const to = i + 1 < marks.length ? Math.max(from, (marks[i + 1].at - t0) / 1000) : duration + 1;
    return drawLines({ font, lines: wrapLines(mark.label, 24), size: 42, color: '0xffffff', x: 60, y: 300, spacing: 12, enable: `between(t,${from.toFixed(3)},${to.toFixed(3)})`, workDir: work, stem: `caption-${i}` });
  });
  const inputs = clips.flatMap((clip) => ['-i', clip]);
  const normalised = clips.map((_, i) => `[${i}:v]fps=30,scale=${w}:${h},setsar=1,format=yuv420p[c${i}]`);
  const graph = [
    ...normalised,
    `${clips.map((_, i) => `[c${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[raw]`,
    'color=c=0x0d0b14:s=1920x1080:r=30[bg]',
    '[raw]scale=1240:900:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[shot]',
    ['[bg][shot]overlay=x=W-w-60:y=(H-h)/2:shortest=1',
      ...drawLines({ font, lines: ['Smirk Wallet v0.3.1 (run 11204)', 'Area H: macOS desktop'], size: 30, color: '0xf5c542', x: 60, y: 120, spacing: 10, workDir: work, stem: 'lane' }),
      `drawtext=fontfile='${font}':text='%{pts\\:gmtime\\:${Math.floor(t0 / 1000)}\\:%Y-%m-%d %T} UTC':fontcolor=0xbbbbbb:fontsize=28:x=60:y=h-120`,
      ...captions,
      'format=yuv420p[v]'].join(','),
  ].join(';');
  const graphFile = join(work, 'filter.txt');
  writeFileSync(graphFile, graph);
  const output = join(outDir, 'macos-desktop.mp4');
  ffmpeg([...inputs, ...filterScriptArgs(graphFile), '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', output]);
  const stamp = (ms) => {
    const s = Math.max(0, Math.round((ms - t0) / 1000));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  writeFileSync(join(outDir, 'CHAPTERS-macos-desktop.md'), [
    '# macOS desktop chapters', '',
    'Smirk Wallet v0.3.1 desktop app, release run 11204, area H. Real speed; holds are deliberate dead air.', '',
    '| Video time | Kind | Operation | Hold (s) |', '| --- | --- | --- | --- |',
    ...timeline.events.map((event) => `| ${stamp(event.start)} | ${event.kind} | ${event.label} | ${(event.holdMs / 1000).toFixed(1)} |`),
    '',
  ].join('\n'), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  return { output, seconds: duration };
}

function readBalances(texts) {
  const balances = {};
  for (const asset of ASSETS) {
    for (let i = 1; i + 1 < texts.length; i++) {
      if (texts[i] === TICKERS[asset] && texts[i - 1] === NAMES[asset] && /^[\d.,]+$/.test(texts[i + 1])) {
        balances[asset] = texts[i + 1];
        break;
      }
    }
  }
  return balances;
}

async function probe(desktop) {
  await desktop.launch();
  try {
    await until(() => desktop.hasText(/^Welcome to Smirk$/), { timeout: 60_000, what: 'the fresh welcome screen' });
    if (desktop.hasButton(/^Unlock$/) || desktop.snapshot().secureFields > 0) throw new SmokeError('the app opened an existing wallet: isolation failed');
    console.log('probe: the isolated app opened at the fresh welcome screen');
  } finally {
    await desktop.quit();
  }
}

async function flow(desktop, options) {
  const evidence = { area: 'H-cross-browser-desktop', lane: 'macos-desktop', release: RELEASE.version, startedAt: new Date().toISOString(), steps: [] };
  const words = readWalletPhrase(options.walletFile, 'SMOKE_ALICE_MNEMONIC');
  const password = randomBytes(24).toString('base64url');
  const canary = makeCanary({ phraseWords: words, exact: [password] });
  const footage = new SegmentRecorder({ desktop, outDir: options.out, screenIndex: options.screen, canary });
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      evidence.steps.push({ name, status: 'pass', ms: Date.now() - started, ...(detail ? { detail } : {}) });
      console.log(`  pass  ${name}`);
      return true;
    } catch (error) {
      const reason = error instanceof SmokeError ? error.message : `driver error (${error?.name ?? 'unknown'})`;
      evidence.steps.push({ name, status: 'fail', reason, ms: Date.now() - started });
      console.log(`  fail  ${name}: ${reason}`);
      return false;
    }
  };
  const homeShown = () => desktop.hasText(/^Bitcoin$/) && desktop.hasText(/^BTC$/);
  const unlock = async () => {
    await footage.secret('Unlock with the password', async () => {
      await until(() => desktop.snapshot().secureFields >= 1, { what: 'the password field' });
      if (!desktop.ax('focus', desktop.pid, 'secure', 0).ok) throw new SmokeError('could not focus the password field');
      desktop.axSecret(['type', desktop.pid], password);
      desktop.press('AXButton', '^Unlock$');
      await until(homeShown, { timeout: 90_000, what: 'Home after unlock' });
    }, 'Home after unlock');
  };

  try {
    await desktop.launch();
    let ok = await step('Welcome screen, recorded', async () => {
      await until(() => desktop.hasText(/^Welcome to Smirk$/), { timeout: 60_000, what: 'the welcome screen' });
      await footage.start('Welcome screen');
      await footage.settled('Welcome screen');
    });
    ok = ok && await step('Import alice, recording stopped', async () => {
      await footage.tap('Tap Import existing', async () => {
        await footage.secret('Import alice: phrase and password entry', async () => {
          desktop.press('AXButton', '^Import existing$');
          await until(() => desktop.ax('press', desktop.pid, 'AXButton', '^Continue$').ok, { what: 'the import warning' });
          await until(() => desktop.ax('focus', desktop.pid, 'text', 0).ok, { what: 'the first phrase field' });
          // Space moves to the next word field, so one typed line fills the grid.
          desktop.axSecret(['type', desktop.pid], words.join(' '));
          desktop.press('AXButton', '^Continue$');
          await until(() => desktop.snapshot().secureFields >= 2, { timeout: 60_000, what: 'the password step' });
          for (const index of [0, 1]) {
            if (!desktop.ax('focus', desktop.pid, 'secure', index).ok) throw new SmokeError('could not focus a password field');
            desktop.axSecret(['type', desktop.pid], password);
          }
          desktop.press('AXButton', '^Import wallet$');
          await until(async () => {
            if (homeShown()) return true;
            desktop.ax('press', desktop.pid, 'AXButton', '^(Continue|Skip for now)$');
            return false;
          }, { timeout: 180_000, every: 3_000, what: 'Home after import' });
        });
      });
      words.fill('');
      await footage.start('Home after import');
    });
    ok = ok && await step('Home balances match Chromium (accessibility tree)', async () => {
      const balances = await until(() => {
        const read = readBalances(desktop.snapshot().texts ?? []);
        return Object.keys(read).length === ASSETS.length ? read : null;
      }, { timeout: 300_000, every: 3_000, what: 'every Home balance in the accessibility tree' });
      evidence.balances = balances;
      await footage.settled('Home with balances');
      await footage.result('Desktop Home balances');
      if (!options.reference || !existsSync(options.reference)) throw new SmokeError('no Chromium balance reference; run the chromium lane of h-firefox.live.mjs first');
      const reference = JSON.parse(readFileSync(options.reference, 'utf8'));
      const ageHours = (Date.now() - Date.parse(reference.at)) / 3_600_000;
      evidence.reference = { at: reference.at, ageHours: Number(ageHours.toFixed(2)) };
      const differ = ASSETS.filter((asset) => amount(reference.balances?.[asset]) !== amount(balances[asset]));
      if (differ.length) throw new SmokeError(`desktop and Chromium differ on ${differ.map((asset) => `${asset} (${balances[asset]} vs ${reference.balances?.[asset]})`).join(', ')}`);
      return { assets: ASSETS.length, referenceAgeHours: evidence.reference.ageHours };
    });
    ok = ok && await step('Lock and unlock, recording stopped around the password', async () => {
      await footage.tap('Tap Lock wallet', async () => desktop.press('AXButton', '^Lock wallet$'));
      await until(() => desktop.snapshot().secureFields >= 1 && desktop.hasButton(/^Unlock$/), { what: 'the lock screen' });
      await footage.settled('Lock screen');
      await unlock();
      await footage.settled('Home after unlock');
      await footage.result('Unlocked desktop Home');
    });
    ok = ok && await step('History detail and explorer link in the default browser', async () => {
      const browser = defaultBrowser();
      let opened = false;
      for (const asset of ['wow', 'xmr', 'btc', 'ltc', 'grin']) {
        await footage.tap('Open an asset', async () => desktop.press('AXButton', `^${NAMES[asset]}\\b`));
        await sleep(3_000);
        const row = desktop.ax('press-after', desktop.pid, '^Activity$', 'AXButton');
        if (!row.ok) {
          await footage.tap('Back to Home', async () => desktop.press('AXButton', '^(◀ )?Back$'));
          continue;
        }
        await until(() => desktop.snapshot().buttons?.some((label) => /View in block explorer/.test(label)), { what: 'the history detail' });
        await footage.settled('History detail');
        await footage.result('History detail');
        await footage.secret('Explorer opens in the default browser, outside the recording', async () => {
          desktop.press('AXButton', '^View in block explorer$');
          await until(() => desktop.ax('frontmost').bundle.toLowerCase() === browser, { timeout: 30_000, what: 'the default browser to come to the front' });
          opened = true;
          await sleep(3_000);
          desktop.ax('activate', desktop.pid);
          await until(() => desktop.frontmost(), { what: 'the wallet to come back to the front' });
        }, 'Back from the explorer');
        await footage.tap('Close the detail', async () => desktop.press('AXButton', '^Close$'));
        await footage.settled('Activity');
        break;
      }
      if (!opened) throw new SmokeError('no asset had a history entry with an explorer link');
      return { browser };
    });
    await step('Quit', async () => {
      await footage.settled('Before quitting');
      await footage.stop();
      footage.card('The app quits');
      await desktop.quit();
      if (desktop.child.exitCode === null && desktop.child.signalCode === null) throw new SmokeError('the app did not quit');
    });
  } finally {
    words.fill('');
    await footage.stop().catch(() => {});
    await desktop.quit();
  }
  const timeline = await footage.finish();
  try {
    const encoded = encodeDesktop(options.out, timeline, options.font);
    evidence.footage = { file: 'macos-desktop.mp4', seconds: Math.round(encoded.seconds), chapters: 'CHAPTERS-macos-desktop.md' };
  } catch (error) {
    evidence.footage = { error: error instanceof Error ? error.message.split('\n')[0] : 'encode failed' };
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = evidence.steps.every((entry) => entry.status === 'pass');
  writeFileSync(join(options.out, 'evidence.json'), JSON.stringify(evidence, null, 1), { mode: 0o600 });
  return evidence;
}

async function main() {
  const options = {
    axBinary: resolve(argument('ax')),
    app: resolve(argument('app')),
    home: resolve(argument('home')),
    out: argument('out') ? resolve(argument('out')) : null,
    walletFile: argument('wallet-file') ? resolve(argument('wallet-file')) : null,
    reference: argument('reference') ? resolve(argument('reference')) : null,
    screen: argument('screen', '0'),
    font: argument('font', undefined),
  };
  const desktop = new Desktop(options);
  if (process.argv.includes('--probe')) return probe(desktop);
  if (!options.out || !options.walletFile) throw new SmokeError('--out and --wallet-file are required for the recorded flow');
  const evidence = await flow(desktop, options);
  console.log(`macOS desktop: ${evidence.ok ? 'OK' : 'FAILED'}; evidence ${join(options.out, 'evidence.json')}`);
  if (!evidence.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`desktop driver refused: ${error instanceof SmokeError ? error.message : `driver error (${error?.name ?? 'unknown'})`}`);
  process.exit(1);
});
