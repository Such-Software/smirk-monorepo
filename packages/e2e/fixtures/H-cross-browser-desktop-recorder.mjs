/**
 * Area H guarded recorder: a browser-agnostic screenshot loop with per-frame
 * redaction, owner-policy holds and a timeline the encoder verifies.
 *
 * Per frame (about four a second): run the in-page guard and the canary, take
 * the screenshot (Chromium masks named surfaces; Firefox has no masks, so any
 * hit becomes a full redaction card), run both again, and drop the frame if
 * the two passes disagree. Identical frames are stored once and the timeline
 * keeps their times, so long static holds cost no disk.
 *
 * Every interaction goes through the helpers below; specs never click or type
 * directly (see the lint in H-cross-browser-desktop-guard.test.mjs):
 *   tap(target, label)          6 s static hold, guard, then click
 *   type(target, value, label)  6 s static hold, then a NON-secret value
 *   choose(target, value, label) 6 s static hold, then a <select> value
 *   settled(label)              waits out Updating/Loading, then 12 s still
 *   result(label)               25 s still, for key results
 *   secret(label, fn)           card frames only while fn types or reveals
 *                               anything secret; resumes after two clean passes
 *
 * Labels are static strings (assertStaticLabel). Nothing here prints a value.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CLEAN_PASS_GAP_MS, FRAME_INTERVAL_MS, GUARD_RULES, HOLDS, assertStaticLabel, verifyTimeline } from './H-cross-browser-desktop-policy.mjs';
import { hCanarySnapshot, hSecretVerdict } from './H-cross-browser-desktop-guard.mjs';

/** Create a directory chain owned by this user with mode 0700 at every level we create. */
export function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** The recorder's own refusals: static text, safe to print. */
export class FootageError extends Error {
  name = 'FootageError';
}

/** One-at-a-time section shared by actions and frame captures. */
class Exclusive {
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const next = this.#tail.then(() => fn(), () => fn());
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class GuardedRecorder {
  /**
   * @param {{ adapter: any, lane: string, outDir: string, canary: { check(s: unknown): string | null }, holds?: typeof HOLDS, interval?: number }} options
   */
  constructor({ adapter, lane, outDir, canary, holds = HOLDS, interval = FRAME_INTERVAL_MS }) {
    this.adapter = adapter;
    this.lane = assertStaticLabel(lane);
    this.outDir = privateDir(outDir);
    this.frameDir = privateDir(join(outDir, 'frames'));
    this.canary = canary;
    this.holds = holds;
    this.interval = interval;
    this.exclusive = new Exclusive();
    this.frames = [];
    this.events = [];
    this.files = new Map();
    this.stats = { captured: 0, stored: 0, cards: 0, dropped: 0, unreadable: 0 };
    this.secretLabel = null;
    this.stopped = true;
    this.loop = null;
    this.startedAt = null;
    this.stoppedAt = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt ??= Date.now();
    this.loop = (async () => {
      while (!this.stopped) {
        const began = Date.now();
        await this.exclusive.run(() => this.#frame());
        await sleep(Math.max(20, this.interval - (Date.now() - began)));
      }
    })();
  }

  /** Stop and write timeline.json (0600). Returns the timeline. */
  async stop() {
    this.stopped = true;
    if (this.loop) await this.loop;
    this.loop = null;
    this.stoppedAt = Date.now();
    const timeline = {
      area: 'H-cross-browser-desktop',
      lane: this.lane,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      imageExt: this.adapter.imageExt,
      holds: this.holds,
      frames: this.frames,
      events: this.events,
      stats: this.stats,
    };
    writeFileSync(join(this.outDir, 'timeline.json'), JSON.stringify(timeline, null, 1), { mode: 0o600 });
    return timeline;
  }

  async #inspect() {
    const verdict = await this.adapter.evaluate(hSecretVerdict, GUARD_RULES);
    let snapshot = await this.adapter.evaluate(hCanarySnapshot);
    const leak = this.canary.check(snapshot);
    snapshot = null;
    let cardLabel = leak ?? verdict.card[0] ?? null;
    if (!cardLabel && verdict.mask.length && this.adapter.maskMode === 'card') cardLabel = verdict.mask[0];
    return { cardLabel, mask: verdict.mask, key: JSON.stringify([verdict.card, verdict.mask, Boolean(leak)]) };
  }

  #card(at, label) {
    this.stats.cards++;
    const last = this.frames.at(-1);
    if (last && last.verdict === 'card' && last.card === label) return;
    this.frames.push({ at, file: null, card: label, verdict: 'card' });
  }

  async #frame() {
    const at = Date.now();
    this.stats.captured++;
    if (this.secretLabel) return this.#card(at, this.secretLabel);
    let first;
    let shot;
    let second;
    try {
      first = await this.#inspect();
      if (first.cardLabel) return this.#card(at, first.cardLabel);
      shot = await this.adapter.screenshot(first.mask);
      second = await this.#inspect();
    } catch {
      this.stats.unreadable++;
      return this.#card(at, 'Screen unreadable');
    }
    if (second.cardLabel || second.key !== first.key) {
      // The screen changed between the passes. The screenshot never leaves memory.
      shot = null;
      this.stats.dropped++;
      return;
    }
    const hash = createHash('sha256').update(shot).digest('hex');
    let file = this.files.get(hash);
    if (!file) {
      file = join('frames', `${String(this.stats.stored).padStart(6, '0')}.${this.adapter.imageExt}`);
      writeFileSync(join(this.outDir, file), shot, { mode: 0o600 });
      this.files.set(hash, file);
      this.stats.stored++;
    }
    const verdict = first.mask.length ? 'masked' : 'clean';
    const last = this.frames.at(-1);
    if (last && last.file === file && last.verdict === verdict) return;
    this.frames.push({ at, file, verdict });
  }

  #event(kind, label, start, extra = {}) {
    const end = Date.now();
    this.events.push({ kind, label, start, end, holdMs: end - start, ...extra });
  }

  /** A static hold: no actions, frames keep coming. */
  async #still(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) await sleep(Math.min(250, ms - (Date.now() - start)) || 1);
    return Date.now() - start;
  }

  chapter(label) {
    assertStaticLabel(label);
    const at = Date.now();
    this.events.push({ kind: 'chapter', label, start: at, end: at, holdMs: 0 });
  }

  async tap(target, label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await this.exclusive.run(() => this.adapter.click(target));
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  /** Non-secret values only (amounts, public addresses). A canary hit refuses. */
  async type(target, value, label) {
    assertStaticLabel(label);
    if (this.canary.check({ text: '', values: [String(value)] })) throw new Error(`refusing to type a known secret through type(); use secret() (${label})`);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await this.exclusive.run(() => this.adapter.fill(target, String(value)));
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  async choose(target, value, label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await this.exclusive.run(() => this.adapter.choose(target, String(value)));
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  /** Any other visible operation (opening a page, reopening the wallet). Same pre-hold as a tap. */
  async act(label, fn) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await this.exclusive.run(fn);
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  /** Key presses such as Escape. Same pre-hold as a tap. */
  async press(key, label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.preTapMs);
    const holdMs = Date.now() - start;
    await this.exclusive.run(() => this.adapter.press(key));
    this.events.push({ kind: 'tap', label, start, end: Date.now(), holdMs });
  }

  /** Wait until Updating/Loading leave the screen (bounded), then hold 12 s. */
  async settled(label, { busy = /Updating…|Loading/, patience = 90_000 } = {}) {
    assertStaticLabel(label);
    const waitStart = Date.now();
    while (Date.now() - waitStart < patience) {
      const text = await this.exclusive.run(() => this.adapter.rootText()).catch(() => '');
      if (!busy.test(text)) break;
      await sleep(500);
    }
    const start = Date.now();
    await this.#still(this.holds.settledMs);
    this.#event('settled', label, start);
  }

  /** Hold a key result on screen for 25 s. */
  async result(label) {
    assertStaticLabel(label);
    const start = Date.now();
    await this.#still(this.holds.resultMs);
    this.#event('result', label, start);
  }

  /**
   * Secret scope: every frame is a redaction card while `fn` runs. `fn` gets
   * hold-free helpers (tap, fill, choose, press) that work only inside the
   * scope. Recording resumes after two consecutive clean guard passes.
   */
  async secret(label, fn, { cleanPatience = 120_000 } = {}) {
    assertStaticLabel(label);
    const start = Date.now();
    this.secretLabel = label;
    let open = true;
    const inside = (action) => {
      if (!open) throw new Error('secret helpers are usable only inside their scope');
      return this.exclusive.run(action);
    };
    const ops = {
      tap: (target) => inside(() => this.adapter.click(target)),
      fill: (target, value) => inside(() => this.adapter.fill(target, value)),
      choose: (target, value) => inside(() => this.adapter.choose(target, value)),
      press: (key) => inside(() => this.adapter.press(key)),
    };
    let failure = null;
    try {
      await fn(ops);
    } catch (error) {
      failure = error;
    }
    open = false;
    // Stay on the card until the screen is clean twice in a row. After a
    // failed scope the screen may still hold a secret: keep the card on (later
    // frames stay redacted until resume()) and report the scope's own error.
    const resumed = await this.#awaitClean(failure ? 10_000 : cleanPatience);
    this.#event('secret', label, start, { resumed });
    if (failure) throw failure;
    if (!resumed) throw new FootageError(`a secret surface stayed visible after: ${label}`);
  }

  /** Leave a card that a failed secret scope left on, once the screen is clean. */
  async resume({ patience = 30_000 } = {}) {
    if (!this.secretLabel) return true;
    return this.#awaitClean(patience);
  }

  async #awaitClean(patience) {
    let clean = 0;
    const deadline = Date.now() + patience;
    while (clean < 2) {
      const pass = await this.exclusive.run(() => this.#inspect()).catch(() => ({ cardLabel: 'Screen unreadable' }));
      clean = pass.cardLabel ? 0 : clean + 1;
      if (clean < 2) {
        if (Date.now() > deadline) return false;
        await sleep(CLEAN_PASS_GAP_MS);
      }
    }
    this.secretLabel = null;
    return true;
  }
}

// ---------------------------------------------------------------- encoding --

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf',
  '/usr/share/fonts/noto/NotoSans-Bold.ttf',
];

export function findFont(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('caption font not found; pass an existing --font');
    return explicit;
  }
  for (const font of FONT_CANDIDATES) if (existsSync(font)) return font;
  const matched = spawnSync('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold'], { encoding: 'utf8' });
  if (matched.status === 0 && matched.stdout && existsSync(matched.stdout.trim())) return matched.stdout.trim();
  throw new Error('no caption font found; pass --font');
}

/** Width and height of a PNG or JPEG. */
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at++; continue; }
      const marker = buffer[at + 1];
      const length = buffer.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  throw new Error('unrecognised frame image');
}

export function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

/** ffmpeg 7 and later read an option value from a file with -/<option>; older builds use -filter_complex_script. */
export function filterScriptArgs(file) {
  const version = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' });
  const major = Number(/ffmpeg version n?(\d+)/.exec(String(version.stdout))?.[1] ?? 0);
  return major >= 7 ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}

/** Word-wrap a static label for drawtext, which does not wrap by itself. */
export function wrapLines(label, width) {
  const lines = [];
  let line = '';
  for (const word of String(label).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function wrapLabel(label, width) {
  return wrapLines(label, width).join('\n');
}

/**
 * One drawtext per line. Newlines inside a drawtext text render as a missing
 * glyph box in ffmpeg 8, so multi-line text is always split here.
 * @param {{ font: string, lines: string[], size: number, color: string, x: string | number, y: number | string, spacing?: number, enable?: string, workDir: string, stem: string }} options
 */
export function drawLines({ font, lines, size, color, x, y, spacing = Math.round(size / 3), enable, workDir, stem }) {
  // Empty lines only add spacing; drawtext gets no empty text.
  return lines.flatMap((line, i) => {
    if (!line) return [];
    const file = join(workDir, `${stem}-${i}.txt`);
    writeFileSync(file, line);
    const top = typeof y === 'number' ? y + i * (size + spacing) : `${y}+${i * (size + spacing)}`;
    return [`drawtext=fontfile='${font}':textfile='${file}':expansion=none:fontcolor=${color}:fontsize=${size}:x=${x}:y=${top}${enable ? `:enable='${enable}'` : ''}`];
  });
}

/** Render a redaction card the size of the lane's frames. */
export function renderCard(path, { width, height, label, font, workDir }) {
  const stem = relative(workDir, path).replace(/[^A-Za-z0-9]/g, '_');
  const size = Math.max(12, Math.round(Math.min(height / 22, width / 19)));
  const perLine = Math.max(12, Math.floor(width / (size * 0.62)));
  const body = [...wrapLines(label, perLine), '', ...wrapLines('Nothing secret is recorded here.', perLine)];
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x15121f:s=${width}x${height}:d=1`,
    '-vf', [
      ...drawLines({ font, lines: ['Redacted'], size: size * 2, color: '0xf5c542', x: '(w-text_w)/2', y: `h/2-${size * 4}`, workDir, stem: `${stem}-title` }),
      ...drawLines({ font, lines: body, size, color: '0xffffff', x: '(w-text_w)/2', y: `h/2-${size}`, workDir, stem: `${stem}-body` }),
      'format=rgb24',
    ].join(','),
    '-frames:v', '1', path,
  ]);
}

/**
 * Encode one lane at real speed (no trimming, no slowdown): every hold stays
 * as long as it was. A 1920x1080 canvas carries the wallet on the right and,
 * on the left, the current operation, the lane and a UTC clock. Writes
 * <lane>.mp4 and CHAPTERS-<lane>.md next to the timeline.
 */
/** @param {string} outDir @param {{ font?: string }} [options] */
export function encodeLane(outDir, { font: explicitFont } = {}) {
  const timeline = JSON.parse(readFileSync(join(outDir, 'timeline.json'), 'utf8'));
  const problems = verifyTimeline(timeline);
  if (problems.length) throw new Error(`refusing to encode ${timeline.lane}: ${[...new Set(problems)].join('; ')}`);
  const real = timeline.frames.find((frame) => frame.file);
  if (!real) throw new Error(`refusing to encode ${timeline.lane}: no recorded frames`);
  const font = findFont(explicitFont);
  const size = imageSize(readFileSync(join(outDir, real.file)));
  const work = privateDir(join(outDir, 'encode'));
  const cards = new Map();
  for (const frame of timeline.frames) {
    if (frame.verdict !== 'card' || cards.has(frame.card)) continue;
    const path = join(work, `card-${cards.size}.${timeline.imageExt}`);
    renderCard(path, { ...size, label: frame.card, font, workDir: work });
    cards.set(frame.card, path);
  }
  const source = (frame) => (frame.verdict === 'card' ? cards.get(frame.card) : join(outDir, frame.file)).replace(/'/g, "'\\''");
  const lines = ['ffconcat version 1.0'];
  timeline.frames.forEach((frame, i) => {
    const until = timeline.frames[i + 1]?.at ?? timeline.stoppedAt;
    lines.push(`file '${source(frame)}'`, `duration ${Math.max(0.001, (until - frame.at) / 1000).toFixed(3)}`);
  });
  // The concat demuxer wants the last file repeated; -t below cuts the excess.
  lines.push(`file '${source(timeline.frames.at(-1))}'`);
  const list = join(work, 'frames.ffconcat');
  writeFileSync(list, `${lines.join('\n')}\n`, { mode: 0o600 });

  // The current operation is the latest event label.
  const t0 = timeline.frames[0].at;
  const marks = timeline.events.map((event) => ({ at: event.start, label: event.label })).sort((a, b) => a.at - b.at);
  const duration = (timeline.stoppedAt - t0) / 1000;
  const captions = marks.flatMap((mark, i) => {
    const from = Math.max(0, (mark.at - t0) / 1000);
    const to = i + 1 < marks.length ? Math.max(from, (marks[i + 1].at - t0) / 1000) : duration + 1;
    return drawLines({ font, lines: wrapLines(mark.label, 30), size: 52, color: '0xffffff', x: 100, y: 300, spacing: 14, enable: `between(t,${from.toFixed(3)},${to.toFixed(3)})`, workDir: work, stem: `caption-${i}` });
  });
  const start = Math.floor(t0 / 1000);
  // Frames may differ in size or pixel format (a window change, a card), and a
  // filtergraph reinit would restart the canvas and drop held frames. So reinit
  // is off and every frame is normalised to one size and format first.
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  const W = even(size.width);
  const H = even(size.height);
  const graph = [
    'color=c=0x0d0b14:s=1920x1080:r=30[bg]',
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x15121f,format=rgb24,fps=30,`
      + 'scale=1100:960:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[shot]',
    [
      '[bg][shot]overlay=x=W-w-100:y=(H-h)/2:shortest=1',
      ...drawLines({ font, lines: ['Smirk Wallet v0.3.1 (run 11204)', `Area H: ${timeline.lane}`], size: 34, color: '0xf5c542', x: 100, y: 120, spacing: 10, workDir: work, stem: 'lane' }),
      `drawtext=fontfile='${font}':text='%{pts\\:gmtime\\:${start}\\:%Y-%m-%d %T} UTC':fontcolor=0xbbbbbb:fontsize=32:x=100:y=h-140`,
      ...captions,
      'format=yuv420p[v]',
    ].join(','),
  ].join(';');
  const graphFile = join(work, 'filter.txt');
  writeFileSync(graphFile, graph);
  const output = join(outDir, `${timeline.lane}.mp4`);
  ffmpeg(['-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', list, ...filterScriptArgs(graphFile), '-map', '[v]', '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', output]);
  chmodSync(output, 0o600);

  const stamp = (ms) => {
    const s = Math.max(0, Math.round((ms - t0) / 1000));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const chapterLines = [
    `# ${timeline.lane} chapters`,
    '',
    `Smirk Wallet v0.3.1, release run 11204, area H. Real speed; holds are deliberate dead air.`,
    '',
    '| Video time | Kind | Operation | Hold (s) |',
    '| --- | --- | --- | --- |',
    ...timeline.events.map((event) => `| ${stamp(event.start)} | ${event.kind} | ${event.label} | ${(event.holdMs / 1000).toFixed(1)} |`),
    '',
    `Frames: ${timeline.stats.stored} stored, ${timeline.stats.cards} card ticks, ${timeline.stats.dropped} dropped by the double guard pass.`,
    '',
  ];
  writeFileSync(join(outDir, `CHAPTERS-${timeline.lane}.md`), chapterLines.join('\n'), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  return { output, seconds: duration, bytes: statSync(output).size };
}
