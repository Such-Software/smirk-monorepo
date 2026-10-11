#!/usr/bin/env node
/**
 * Encode the area D guarded footage into one reviewable video.
 *
 * Input is a footage root written by fixtures/D-messaging-federation-footage.ts:
 * one directory per wallet (alice, bob, carol), each with JPEG frames and a
 * timeline.json. Output is a three-column grid (alice, bob, carol) at 1920x1080
 * with a caption bar (chapter, wallet names, UTC clock), plus CHAPTERS.md.
 *
 * Policy, enforced before anything is encoded:
 *   - Every frame has a guard verdict. A clean frame names a frame file (or
 *     repeats the previous one); a redacted frame names a static card label.
 *     Anything else refuses the whole encode.
 *   - Every recorded hold meets the video policy written in the timeline.
 *   - No trimming and no speed change: playback is 1.0x wall clock, so the
 *     dead air the owner asked for is all there. Columns share one clock;
 *     a wallet that was not yet recording shows a static card.
 *   - Output stays on this machine (0700 directory). Nothing is uploaded or
 *     promoted.
 *
 *   node packages/e2e/scripts/D-messaging-federation-encode.mjs \
 *     --footage <root with alice/ bob/ carol/> [--out <dir>] [--font <ttf>]
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { heldLongEnough } from '../fixtures/hold-timer.mjs';

const WALLETS = ['alice', 'bob', 'carol'];
const FORMAT = 'smirk-e2e-guarded-footage/1';
const FRAME = { w: 760, h: 1200 };
/** Each column is 640 wide; the popup keeps its aspect at 614x970 inside it. */
const COLUMN = { w: 640, h: 970 };
const SHOT = { w: 614, h: 970 };
/** Caption bar above the grid: chapter and clock, then wallet names. */
const BAR = 110;
const FPS = 30;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function run(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

const escapeText = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');

/** Validate one wallet timeline against the policy; return it. */
export function validateTimeline(timeline, dir) {
  if (timeline?.format !== FORMAT) throw new Error('timeline format is not the guarded footage format');
  if (!Array.isArray(timeline.frames) || !Array.isArray(timeline.holds)) throw new Error('timeline is missing frames or holds');
  let previousFile = null;
  for (const frame of timeline.frames) {
    if (typeof frame.at !== 'number') throw new Error('a frame has no timestamp');
    if (frame.verdict === 'clean') {
      if (frame.same) {
        if (!previousFile) throw new Error('a repeated clean frame has nothing to repeat');
      } else {
        if (typeof frame.file !== 'string' || !/^\d{6}\.jpg$/.test(frame.file) || (dir && !existsSync(join(dir, frame.file)))) {
          throw new Error('a clean frame names no frame file');
        }
        previousFile = frame.file;
      }
    } else if (frame.verdict === 'redacted') {
      if (typeof frame.card !== 'string' || !frame.card) throw new Error('a redacted frame has no card label');
      previousFile = null;
    } else {
      throw new Error('a frame has no guard verdict; refusing to encode');
    }
  }
  for (const hold of timeline.holds) {
    if (typeof hold.ms !== 'number' || typeof hold.policyMs !== 'number' || !heldLongEnough(hold.ms, hold.policyMs)) {
      throw new Error(`a ${hold.kind} hold is shorter than the video policy; refusing to encode`);
    }
  }
  return timeline;
}

function card(dir, label, font, cache) {
  if (cache.has(label)) return cache.get(label);
  const file = join(dir, `card-${cache.size}.jpg`);
  const text = escapeText(label);
  run([
    '-f', 'lavfi', '-i', `color=c=0x15121f:s=${FRAME.w}x${FRAME.h}`,
    '-frames:v', '1',
    '-vf', `drawtext=fontfile='${font}':text='Redacted':fontcolor=0xf5c542:fontsize=54:x=(w-text_w)/2:y=h/2-70,` +
      `drawtext=fontfile='${font}':text='${text}':fontcolor=0xd0d0d0:fontsize=30:x=(w-text_w)/2:y=h/2+10`,
    file,
  ]);
  cache.set(label, file);
  return file;
}

/** Concat list for one wallet on the shared clock [start, end] (seconds). */
function concatList(dir, timeline, start, end, font, cards, cardDir) {
  const entries = [];
  const idle = card(cardDir, 'not recording yet', font, cards);
  const first = timeline.frames[0]?.at ?? end * 1000;
  if (first / 1000 > start) entries.push([idle, first / 1000 - start]);
  let current = null;
  let since = 0;
  const flush = (until) => {
    if (current) entries.push([current, Math.max(0, until - since)]);
  };
  for (const frame of timeline.frames) {
    const at = frame.at / 1000;
    let file;
    if (frame.verdict === 'clean') file = frame.same ? current : join(dir, frame.file);
    else file = card(cardDir, frame.card, font, cards);
    if (file === current) continue;
    flush(at);
    current = file;
    since = at;
  }
  flush(end);
  const lines = [];
  for (const [file, seconds] of entries) {
    if (seconds <= 0) continue;
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`, `duration ${seconds.toFixed(3)}`);
  }
  // The concat demuxer needs the last file repeated to honour its duration.
  if (entries.length) lines.push(`file '${entries.at(-1)[0].replace(/'/g, "'\\''")}'`);
  return lines.join('\n');
}

/** Segment roots under `root`: the root itself, or its segment-* directories in order. */
function segmentsOf(root) {
  if (existsSync(join(root, WALLETS[0], 'timeline.json'))) return [root];
  const found = readdirSync(root)
    .filter((name) => /^segment-\d+$/.test(name) && existsSync(join(root, name, WALLETS[0], 'timeline.json')))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
    .map((name) => join(root, name));
  if (!found.length) throw new Error('no guarded footage found under --footage');
  return found;
}

function loadSegment(segment) {
  return WALLETS.map((wallet) => {
    const dir = join(segment, wallet);
    const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
    return { wallet, dir, timeline: validateTimeline(timeline, dir) };
  });
}

function main() {
  const root = resolve(argument('footage'));
  const font = argument('font', existsSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf')
    ? '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  if (!existsSync(font)) throw new Error('caption font not found; pass --font');
  // Validate EVERY segment before encoding anything.
  const segments = segmentsOf(root).map(loadSegment);
  // Default: beside the raw tree, ~/Build/smirk-e2e/v<ver>-<label>/footage/D-messaging-federation.
  const rawAt = root.lastIndexOf('/footage/raw/');
  const fallback = rawAt >= 0
    ? join(root.slice(0, rawAt), 'footage', 'D-messaging-federation')
    : join(homedir(), 'Build', 'smirk-e2e', 'footage', 'D-messaging-federation');
  const out = resolve(argument('out', fallback));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const work = join(out, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { mode: 0o700 });

  const encoded = segments.map((timelines, index) => encodeSegment(timelines, work, index, font));
  // Segments are consecutive workers of one run (a failed test restarts the
  // worker); the gap between them is the time the next worker spent unlocking.
  const list = join(work, 'segments.txt');
  writeFileSync(list, encoded.map((s) => `file '${s.video}'`).join('\n'), { mode: 0o600 });
  const video = join(out, 'D-messaging-federation.mp4');
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);

  const stamp = (s) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 19);
  const rows = [];
  let offset = 0;
  encoded.forEach((segment, i) => {
    if (i > 0) {
      const gap = segment.start - encoded[i - 1].end;
      rows.push(`| ${stamp(offset)} | (worker restarted; ${Math.round(gap)} s not recorded) |`);
    }
    for (const c of segment.chapters) rows.push(`| ${stamp(offset + c.from)} | ${c.label} |`);
    offset += segment.end - segment.start;
  });
  const md = ['# Area D: messaging and federation', '',
    `Wall clock from ${new Date(encoded[0].start * 1000).toISOString()} (1.0x, untrimmed; ${encoded.length} segment(s)).`, '',
    '| Offset | Chapter |', '| --- | --- |', ...rows, ''].join('\n');
  writeFileSync(join(out, 'CHAPTERS.md'), md, { mode: 0o600 });
  if (!process.argv.includes('--keep-work')) rmSync(work, { recursive: true, force: true });
  console.log(`Encoded ${rows.length} chapter rows over ${stamp(offset)} from ${encoded.length} segment(s) into ${out}.`);
}

/** Encode one segment (three columns on one clock); return its file and chapters. */
function encodeSegment(timelines, work, index, font) {
  const start = Math.min(...timelines.map((t) => t.timeline.startedAt)) / 1000;
  const end = Math.max(...timelines.map((t) => t.timeline.stoppedAt)) / 1000;
  // One column per wallet, on the shared clock.
  const columns = [];
  for (const { wallet, dir, timeline } of timelines) {
    const cards = new Map();
    const cardDir = join(work, `${index}-${wallet}-cards`);
    mkdirSync(cardDir, { mode: 0o700 });
    const list = join(work, `${index}-${wallet}.txt`);
    writeFileSync(list, concatList(dir, timeline, start, end, font, cards, cardDir), { mode: 0o600 });
    const column = join(work, `${index}-${wallet}.mp4`);
    // `-t` pins every column to the shared clock: the fps filter otherwise
    // stretches the final still by the previous interval at end of input.
    run(['-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${SHOT.w}:${SHOT.h},pad=${COLUMN.w}:${COLUMN.h}:(ow-iw)/2:0:color=0x0d0b14,fps=${FPS},format=yuv420p`,
      '-t', (end - start).toFixed(3),
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', column]);
    columns.push(column);
  }

  // Chapters come from the marks (identical on every wallet; take the union).
  const marks = [...new Map(timelines.flatMap((t) => t.timeline.marks).map((m) => [`${m.at}:${m.label}`, m])).values()]
    .sort((a, b) => a.at - b.at);
  const chapters = marks.map((mark, i) => ({
    label: mark.label,
    from: mark.at / 1000 - start,
    to: (marks[i + 1] ? marks[i + 1].at / 1000 : end) - start,
  }));
  // Caption bar, two rows: the chapter (operation) and the UTC wall clock, then
  // the wallet name over each column.
  const chapterText = chapters.map((c) =>
    `drawtext=fontfile='${font}':text='${escapeText(c.label)}':fontcolor=0xffffff:fontsize=30:x=24:y=14:enable='between(t,${c.from.toFixed(2)},${c.to.toFixed(2)})'`,
  );
  const clock = `drawtext=fontfile='${font}':text='%{pts\\:gmtime\\:${Math.floor(start)}} UTC':fontcolor=0xd0d0d0:fontsize=30:x=w-text_w-24:y=14`;
  const names = WALLETS.map((wallet, i) =>
    `drawtext=fontfile='${font}':text='${wallet}':fontcolor=0xf5c542:fontsize=30:x=${i * COLUMN.w + (COLUMN.w - SHOT.w) / 2}:y=64`,
  );
  const graph = [
    `[0:v][1:v][2:v]hstack=inputs=3[grid]`,
    `[grid]pad=1920:1080:0:${BAR}:color=0x0d0b14[framed]`,
    `[framed]${[...names, clock, ...chapterText].join(',')},format=yuv420p[v]`,
  ].join(';');
  const video = join(work, `segment-${index}.mp4`);
  run([...columns.flatMap((c) => ['-i', c]), '-filter_complex', graph, '-map', '[v]',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-r', String(FPS), video]);
  return { video, chapters, start, end };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`area D encode refused: ${String(error?.message ?? error).split('\n')[0]}`);
    process.exit(1);
  }
}
