#!/usr/bin/env node
/**
 * Encode the F-legacy-recovery guarded footage into video, at 1.0x.
 *
 * Input: every session under <run>/raw/F-legacy-recovery/<wallet>/<session>/
 * (timeline.json and its frames, written by fixtures/F-legacy-recovery-footage.ts;
 * one session per wallet import, so a restarted worker or a later invocation
 * adds a session instead of replacing one). A timeline directly under
 * <wallet>/ (the earlier layout) is read as one more session. Output, beside
 * it in <run>/F-legacy-recovery/ (mode 0700): one MP4 per session page, named
 * <wallet>-<session>[-page-N].mp4, and CHAPTERS.md. Nothing is trimmed, sped up
 * or uploaded: every hold the run recorded plays for its full length, and
 * redacted spans play as a static labelled card for exactly as long as they
 * lasted.
 *
 * Refuses, before encoding anything:
 *   - a frame without a guard verdict (kind clean or mask, with reasons), or a
 *     missing frame file;
 *   - a hold shorter than the owner's policy (pre-tap 6 s, settled 12 s,
 *     result 25 s), or a timeline whose recorded policy is weaker;
 *   - a step (tap, typed value, toggle, choice, redacted step) without its
 *     still pause before it, or whose resulting screen was not held before the
 *     next step began: a screen the run passed through must not flash by. The
 *     one exception is a screen that counts itself down (the Send receipt):
 *     steps marked `urgent: 'countdown'` may form one chain of at most
 *     MAX_COUNTDOWN_CHAIN steps, in which a step's screen goes unheld only
 *     when the next step continues the chain, a step skips its pause only when
 *     it continues one, and the last step's screen is held;
 *   - a marker label that looks like a value (a URL, a long number or hex).
 *
 * Usage: node packages/e2e/scripts/F-legacy-recovery-encode.mjs [--run <dir>] [--font <ttf>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { heldLongEnough } from '../fixtures/hold-timer.mjs';
import { RC_FOOTAGE_ROOT } from '../fixtures/release-candidate.mjs';

const POLICY = { 'pre-tap': 6_000, settled: 12_000, result: 25_000 };
/** Steps that may skip a hold around a self-closing screen: into it, a password on the way, out of its countdown. */
const URGENT_REASONS = new Set(['countdown']);
const MAX_COUNTDOWN_CHAIN = 3;
/** Slack when lining a hold up with the step it belongs to; hold lengths use hold-timer.mjs. */
const TOLERANCE_MS = 25;
const FPS = 30;
const BAR = 120;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
}

const looksLikeValue = (label) => /:\/\/|[0-9a-f]{16,}|\d{6,}/i.test(label);

/** Validate one timeline; returns the problems found (empty when it may be encoded). */
export function auditTimeline(timeline, walletDir) {
  const problems = [];
  for (const [kind, min] of Object.entries(POLICY)) {
    const key = { 'pre-tap': 'tapPauseMs', settled: 'settledHoldMs', result: 'resultHoldMs' }[kind];
    if (!(timeline.policy?.[key] >= min)) problems.push(`recorded policy ${key} is below ${min} ms`);
  }
  const holds = timeline.holds ?? [];
  for (const hold of holds) {
    const min = POLICY[hold.kind];
    if (min === undefined) problems.push(`unknown hold kind ${String(hold.kind).slice(0, 20)}`);
    else if (!(hold.plannedMs >= min) || !heldLongEnough(hold.until - hold.from, min)) {
      problems.push(`a ${hold.kind} hold lasted ${hold.until - hold.from} ms, below the ${min} ms policy`);
    }
  }
  if (timeline.policy?.holdAfterEveryStep !== true || !Array.isArray(timeline.steps)) {
    problems.push('the timeline does not record a held screen after every step');
  }
  const steps = timeline.steps ?? [];
  const urgent = (step) => step?.urgent !== undefined;
  const heldAfter = (i) => {
    const next = steps[i + 1]?.from ?? Number.POSITIVE_INFINITY;
    return holds.some((h) => (h.kind === 'settled' || h.kind === 'result') && h.from >= steps[i].until - TOLERANCE_MS && h.from < next);
  };
  // A step continues a countdown chain when the step before it is urgent and left its screen unheld.
  const continues = (i) => i > 0 && urgent(steps[i - 1]) && !heldAfter(i - 1);
  let chain = 0;
  steps.forEach((step, i) => {
    const what = `step ${i} (${String(step.kind).slice(0, 10)})`;
    if (urgent(step) && (!URGENT_REASONS.has(step.urgent) || !['tap', 'secret'].includes(step.kind))) {
      problems.push(`${what} claims an unknown urgency`);
    }
    chain = urgent(step) ? (continues(i) ? chain + 1 : 1) : 0;
    if (chain > MAX_COUNTDOWN_CHAIN) problems.push(`${what} makes a countdown chain longer than ${MAX_COUNTDOWN_CHAIN} steps`);
    const paused = holds.some((h) => h.kind === 'pre-tap' && h.from >= step.from - TOLERANCE_MS && h.until <= step.until + TOLERANCE_MS);
    if (step.kind !== 'secret' && !paused && !(urgent(step) && continues(i))) {
      problems.push(`${what} had no still pause before it`);
    }
    if (!heldAfter(i) && !(urgent(step) && urgent(steps[i + 1]))) {
      problems.push(`the screen after ${what} was not held before the next step`);
    }
  });
  for (const page of timeline.pages ?? []) {
    for (const frame of page.frames ?? []) {
      if (!['clean', 'mask'].includes(frame.kind) || !Array.isArray(frame.reasons)) {
        problems.push(`frame ${String(frame.file).slice(0, 20)} has no guard verdict`);
      } else if (!existsSync(join(walletDir, page.dir, frame.file))) {
        problems.push(`frame ${String(frame.file).slice(0, 20)} is missing`);
      }
    }
  }
  for (const mark of timeline.marks ?? []) {
    if (typeof mark.label !== 'string' || looksLikeValue(mark.label)) problems.push('a marker label looks like a value');
  }
  return problems;
}

/** Image/duration list for one page: frames and cards in time order, each shown until the next. */
export function segments(page, pageDir, cardImage) {
  const events = [
    ...(page.frames ?? []).map((f) => ({ from: f.from, until: f.until, image: join(pageDir, f.file) })),
    ...(page.cards ?? []).map((c) => ({ from: c.from, until: c.until, image: cardImage(c.label) })),
  ].sort((a, b) => a.from - b.from);
  return events.map((e, i) => {
    const next = events[i + 1];
    const end = next ? next.from : e.until + 1_000;
    return { image: e.image, seconds: Math.max(1 / FPS, (end - e.from) / 1000), from: e.from };
  });
}

/**
 * Every recorded session, oldest first: <wallet>/<session>/timeline.json, plus
 * a timeline directly under <wallet>/ from the earlier single-session layout.
 * Names are path segments the recorder chose (wallet, time, worker, process).
 */
export function sessionsUnder(raw) {
  const out = [];
  for (const wallet of readdirSync(raw).sort()) {
    const walletDir = join(raw, wallet);
    if (!statSync(walletDir).isDirectory()) continue;
    if (existsSync(join(walletDir, 'timeline.json'))) out.push({ wallet, name: wallet, dir: walletDir });
    for (const session of readdirSync(walletDir).sort()) {
      const dir = join(walletDir, session);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'timeline.json'))) out.push({ wallet, name: `${wallet}-${session}`, dir });
    }
  }
  return out;
}

/** Width and height from a JPEG's start-of-frame marker. */
export function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('not a JPEG frame');
    const marker = bytes[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error('JPEG frame has no size');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Chapter time, HH:MM:SS. */
function clockTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

/** ASS event time, H:MM:SS.cc. */
function assTime(ms) {
  const cs = Math.max(0, Math.floor(ms / 10));
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor((cs % 360_000) / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}`;
}

/** Captions as ASS, sized in output pixels (an SRT is scaled from a 288-line canvas). */
function captionsAss(marks, start, endMs, height) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 760', `PlayResY: ${height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Caption,Arial,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,1,16,16,58,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = marks.map((m, i) => {
    const from = m.at - start;
    // Each caption holds until the next; the last holds to the end.
    const to = Math.max(from + 500, (marks[i + 1]?.at ?? start + endMs) - start);
    return `Dialogue: 0,${assTime(from)},${assTime(to)},Caption,,0,0,0,,${String(m.label).replace(/[{}\\]/g, '')}`;
  });
  return `${[...head, ...events].join('\n')}\n`;
}

function main() {
  const run = resolve(argument('run', RC_FOOTAGE_ROOT));
  const fontDefault = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync);
  const font = argument('font', fontDefault);
  if (!font || !existsSync(font)) throw new Error('caption font not found; pass --font');
  const raw = join(run, 'raw', 'F-legacy-recovery');
  if (!existsSync(raw)) throw new Error('no F-legacy-recovery footage under this run');
  const out = join(run, 'F-legacy-recovery');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const work = join(out, '.work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { mode: 0o700 });

  const timelines = sessionsUnder(raw).map((s) => ({ ...s, timeline: JSON.parse(readFileSync(join(s.dir, 'timeline.json'), 'utf8')) }));
  if (timelines.length === 0) throw new Error('no F-legacy-recovery timeline under this run');
  const problems = timelines.flatMap(({ name, timeline, dir }) => auditTimeline(timeline, dir).map((p) => `${name}: ${p}`));
  if (problems.length) throw new Error(`refusing to encode:\n  ${problems.join('\n  ')}`);

  const escape = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
  // Cards match the page's frame size and pixel format: a change of either
  // mid-stream re-creates ffmpeg's filter graph, which drops the frames
  // around it and freezes the caption and clock over a hold.
  const cards = new Map();
  const cardFor = (size) => (label) => {
    const key = `${size.width}x${size.height}|${label}`;
    if (!cards.has(key)) {
      const file = join(work, `card-${cards.size}.jpg`);
      ffmpeg(['-f', 'lavfi', '-i', `color=c=0x101014:s=${size.width}x${size.height}`, '-frames:v', '1', '-vf',
        `drawtext=fontfile='${font}':text='${escape(label)}':fontcolor=0xdddddd:fontsize=${Math.round(size.width / 22)}:x=(w-text_w)/2:y=(h-text_h)/2,format=yuvj420p`, file]);
      cards.set(key, file);
    }
    return cards.get(key);
  };

  const chapters = ['# F-legacy-recovery footage', '', `Run: ${timelines[0]?.timeline.run ?? 'unknown'}`, ''];
  for (const { wallet, name, dir, timeline } of timelines) {
    timeline.pages.forEach((page, index) => {
      const first = page.frames?.[0];
      const size = first ? jpegSize(readFileSync(join(dir, page.dir, first.file))) : { width: 760, height: 1200 };
      const list = segments(page, join(dir, page.dir), cardFor(size));
      if (list.length === 0) return;
      const start = list[0].from;
      const concat = join(work, `${name}-${index}.txt`);
      const lines = ['ffconcat version 1.0'];
      for (const s of list) lines.push(`file '${s.image}'`, `duration ${s.seconds.toFixed(3)}`);
      // The concat demuxer only honours the last duration when another entry follows it.
      lines.push(`file '${list.at(-1).image}'`, `duration ${(1 / FPS).toFixed(3)}`);
      writeFileSync(concat, `${lines.join('\n')}\n`, { mode: 0o600 });

      // The fps filter pads past the last image at end of input; cap at the recorded length.
      const total = list.reduce((sum, s) => sum + s.seconds, 0);
      const marks = (timeline.marks ?? []).filter((m) => m.at >= start);
      const captions = join(work, `${name}-${index}.ass`);
      writeFileSync(captions, captionsAss(marks, start, total * 1000, 1200 + BAR), { mode: 0o600 });

      // A text file keeps the clock's own escaping away from the filtergraph's.
      const clockText = join(work, `${name}-${index}-clock.txt`);
      writeFileSync(clockText, `${wallet}  %{pts:gmtime:${Math.floor(start / 1000)}:%Y-%m-%d %H\\:%M\\:%S} UTC`, { mode: 0o600 });
      // Caption bar: the operation on the first line, wallet and UTC clock on the second.
      const clock = `drawtext=fontfile='${font}':fontcolor=0xf5c542:fontsize=24:x=16:y=h-40:textfile='${clockText}'`;
      const graph = [
        `fps=${FPS}`,
        'scale=760:1200:force_original_aspect_ratio=decrease',
        `pad=760:${1200 + BAR}:(ow-iw)/2:0:color=0x0d0b14`,
        `ass='${captions}'`,
        clock,
        'format=yuv420p',
      ].join(',');
      const file = join(out, `${name}${index ? `-page-${index}` : ''}.mp4`);
      // Constant frame rate: without it the muxer may keep one frame for a long
      // static hold, so the burned-in caption and clock freeze and players and
      // editors that seek by frame skip the dead air.
      ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', graph, '-t', total.toFixed(3),
        '-fps_mode', 'cfr', '-r', String(FPS), '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', file]);

      chapters.push(`## ${name}${index ? ` (page ${index})` : ''}`, '');
      let lastTest = null;
      for (const m of marks) {
        if (m.test === lastTest) continue;
        lastTest = m.test;
        chapters.push(`- ${clockTime(m.at - start)} ${m.test || '(setup)'}`);
      }
      chapters.push('');
    });
  }
  writeFileSync(join(out, 'CHAPTERS.md'), `${chapters.join('\n')}\n`, { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  console.log(`Encoded ${timelines.length} wallet session timeline(s) into ${out}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`encode refused: ${String(error instanceof Error ? error.message : error)}`);
    process.exit(1);
  }
}
