#!/usr/bin/env node
/**
 * Encode the F-legacy-recovery guarded footage into video, at 1.0x.
 *
 * Input: <run>/raw/F-legacy-recovery/<wallet>/timeline.json and its frames,
 * written by fixtures/F-legacy-recovery-footage.ts. Output, beside it in
 * <run>/F-legacy-recovery/ (mode 0700): one MP4 per wallet page and
 * CHAPTERS.md. Nothing is trimmed, sped up or uploaded: every hold the run
 * recorded plays for its full length, and redacted spans play as a static
 * labelled card for exactly as long as they lasted.
 *
 * Refuses, before encoding anything:
 *   - a frame without a guard verdict (kind clean or mask, with reasons), or a
 *     missing frame file;
 *   - a hold shorter than the owner's policy (pre-tap 6 s, settled 12 s,
 *     result 25 s), or a timeline whose recorded policy is weaker;
 *   - a marker label that looks like a value (a URL, a long number or hex).
 *
 * Usage: node packages/e2e/scripts/F-legacy-recovery-encode.mjs [--run <dir>] [--font <ttf>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const POLICY = { 'pre-tap': 6_000, settled: 12_000, result: 25_000 };
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
  for (const hold of timeline.holds ?? []) {
    const min = POLICY[hold.kind];
    if (min === undefined) problems.push(`unknown hold kind ${String(hold.kind).slice(0, 20)}`);
    else if (!(hold.plannedMs >= min) || !(hold.until - hold.from >= min - TOLERANCE_MS)) {
      problems.push(`a ${hold.kind} hold lasted ${hold.until - hold.from} ms, below the ${min} ms policy`);
    }
  }
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
  const run = resolve(argument('run', join(homedir(), 'Build', 'smirk-e2e', 'v0.3.1-run-11204', 'footage')));
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

  const wallets = readdirSync(raw).filter((d) => existsSync(join(raw, d, 'timeline.json')));
  const timelines = wallets.map((wallet) => ({ wallet, timeline: JSON.parse(readFileSync(join(raw, wallet, 'timeline.json'), 'utf8')) }));
  const problems = timelines.flatMap(({ wallet, timeline }) => auditTimeline(timeline, join(raw, wallet)).map((p) => `${wallet}: ${p}`));
  if (problems.length) throw new Error(`refusing to encode:\n  ${problems.join('\n  ')}`);

  const escape = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
  const cards = new Map();
  const cardImage = (label) => {
    if (!cards.has(label)) {
      const file = join(work, `card-${cards.size}.jpg`);
      ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x101014:s=760x1200', '-frames:v', '1', '-vf',
        `drawtext=fontfile='${font}':text='${escape(label)}':fontcolor=0xdddddd:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2`, file]);
      cards.set(label, file);
    }
    return cards.get(label);
  };

  const chapters = ['# F-legacy-recovery footage', '', `Run: ${timelines[0]?.timeline.run ?? 'unknown'}`, ''];
  for (const { wallet, timeline } of timelines) {
    timeline.pages.forEach((page, index) => {
      const list = segments(page, join(raw, wallet, page.dir), cardImage);
      if (list.length === 0) return;
      const start = list[0].from;
      const concat = join(work, `${wallet}-${index}.txt`);
      const lines = ['ffconcat version 1.0'];
      for (const s of list) lines.push(`file '${s.image}'`, `duration ${s.seconds.toFixed(3)}`);
      // The concat demuxer only honours the last duration when another entry follows it.
      lines.push(`file '${list.at(-1).image}'`, `duration ${(1 / FPS).toFixed(3)}`);
      writeFileSync(concat, `${lines.join('\n')}\n`, { mode: 0o600 });

      // The fps filter pads past the last image at end of input; cap at the recorded length.
      const total = list.reduce((sum, s) => sum + s.seconds, 0);
      const marks = (timeline.marks ?? []).filter((m) => m.at >= start);
      const captions = join(work, `${wallet}-${index}.ass`);
      writeFileSync(captions, captionsAss(marks, start, total * 1000, 1200 + BAR), { mode: 0o600 });

      // A text file keeps the clock's own escaping away from the filtergraph's.
      const clockText = join(work, `${wallet}-${index}-clock.txt`);
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
      const file = join(out, `${wallet}${index ? `-page-${index}` : ''}.mp4`);
      ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', graph, '-t', total.toFixed(3),
        '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', file]);

      chapters.push(`## ${wallet}${index ? ` (page ${index})` : ''}`, '');
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
  console.log(`Encoded ${timelines.length} wallet timeline(s) into ${out}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`encode refused: ${String(error instanceof Error ? error.message : error)}`);
    process.exit(1);
  }
}
