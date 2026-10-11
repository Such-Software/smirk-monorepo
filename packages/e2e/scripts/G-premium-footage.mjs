#!/usr/bin/env node
/**
 * Encode one G-premium guarded footage run (fixtures/G-premium-footage.ts) into
 * an MP4 at 1.0x, with no trimming: the owner wants the dead air.
 *
 *   node packages/e2e/scripts/G-premium-footage.mjs --run <run directory> [--out <directory>]
 *     [--font <ttf>] [--fps 10]
 *
 * Before anything is encoded the timeline is validated, and the run is refused
 * when any frame lacks a guard verdict, a frame file is missing or outside its
 * track, a hold is shorter than policy, a label is not a static phrase, or a
 * tap left a screen that got no settled or result hold before the next action
 * on that window. A tap whose pause came after it (the send receipt closes
 * itself on a timer) must be listed as a policy exception.
 *
 * Layout (1920x1080): one column per wallet page (alice, bob, carol, in that
 * order), each followed by its window lane, which shows whichever checkout tab
 * or second wallet window was acted on most recently. A caption bar carries the
 * operation, the wallet, the latest action and a UTC clock. Redaction cards are
 * drawn here; the recorder kept no pixels for them.
 *
 * Output stays beside the run (0700). Nothing is promoted or uploaded.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { heldLongEnough } from '../fixtures/hold-timer.mjs';

export const MIN_HOLD_MS = Object.freeze({ tap: 6_000, type: 6_000, close: 6_000, settled: 12_000, result: 25_000 });
const VERDICTS = new Set(['clean', 'masked', 'card']);
const ACTIONS = new Set(['tap', 'type', 'close']);
const HELD = new Set(['settled', 'result']);
const EXCEPTION_RULES = new Set(['pause-after-tap']);
const LABEL = /^[A-Za-z][A-Za-z0-9 ,.'()&:+-]{0,79}$/;
const NAME = /^[a-z]+(-[a-z0-9]+){0,4}$/;
const WALLET_ORDER = ['alice', 'bob', 'carol'];

const staticLabel = (label) => typeof label === 'string' && LABEL.test(label) && !/:\/\//.test(label)
  && !/\d{5,}/.test(label) && !/[A-Za-z0-9_-]{24,}/.test(label)
  && !/\b(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{10,}/.test(label);

/** Every reason to refuse this timeline. Empty means it may be encoded. */
export function validateTimeline(timeline, runDir, exists = existsSync) {
  const problems = [];
  if (timeline?.area !== 'G-premium' || timeline?.schema !== 1) return ['not a G-premium footage timeline (schema 1)'];
  const policy = timeline.policy ?? {};
  if (!(policy.tapPauseMs >= MIN_HOLD_MS.tap)) problems.push('the recorded tap pause policy is below 6 s');
  if (!(policy.settledHoldMs >= MIN_HOLD_MS.settled)) problems.push('the recorded settled hold policy is below 12 s');
  if (!(policy.resultHoldMs >= MIN_HOLD_MS.result)) problems.push('the recorded result hold policy is below 25 s');
  if (!Array.isArray(timeline.tracks) || timeline.tracks.length === 0) problems.push('no recorded tracks');
  const names = new Set();
  for (const track of timeline.tracks ?? []) {
    if (!NAME.test(track.name ?? '') || !NAME.test(track.dir ?? '') || !NAME.test(track.wallet ?? '')) {
      problems.push('a track has an unsafe name');
      continue;
    }
    if (names.has(track.dir)) problems.push(`two tracks share ${track.dir}`);
    names.add(track.dir);
    let previous = -Infinity;
    for (const segment of track.segments ?? []) {
      if (!VERDICTS.has(segment.verdict)) {
        problems.push(`a ${track.dir} frame has no guard verdict`);
        continue;
      }
      if (!(segment.from <= segment.to) || segment.from < previous) problems.push(`${track.dir} frames are out of order`);
      previous = segment.from;
      if (segment.verdict === 'card') {
        if (segment.file !== undefined) problems.push(`a ${track.dir} redaction card kept a frame file`);
        if (!staticLabel(segment.card)) problems.push(`a ${track.dir} redaction card has an unsafe caption`);
        continue;
      }
      const file = normalize(segment.file ?? '');
      if (!segment.file || isAbsolute(file) || !file.startsWith(`${track.dir}/`) || file.includes('..') || !/\.jpg$/.test(file)) {
        problems.push(`a ${track.dir} frame points outside its track`);
      } else if (!exists(join(runDir, file))) {
        problems.push(`a ${track.dir} frame file is missing`);
      }
    }
  }
  for (const hold of timeline.holds ?? []) {
    const minimum = MIN_HOLD_MS[hold.kind];
    if (minimum === undefined) problems.push('a hold has an unknown kind');
    else if (!heldLongEnough(hold.ms, minimum)) problems.push(`a ${hold.kind} hold lasted ${hold.ms} ms, under the ${minimum} ms policy`);
    if (!staticLabel(hold.label)) problems.push('a hold has an unsafe label');
    if (hold.after !== undefined && (hold.after !== true || hold.kind !== 'tap')) problems.push('only a tap may hold after itself');
  }
  problems.push(...settledAfterEachTap(timeline.holds ?? [], names));
  const exceptions = timeline.exceptions ?? [];
  for (const exception of exceptions) {
    if (!staticLabel(exception.label) || !EXCEPTION_RULES.has(exception.rule) || !NAME.test(exception.track ?? '')) {
      problems.push('a policy exception is malformed');
    }
  }
  for (const hold of (timeline.holds ?? []).filter((h) => h.after === true)) {
    if (!exceptions.some((e) => e.label === hold.label && e.track === hold.track && e.at === hold.from)) {
      problems.push(`the tap "${hold.label}" held after itself without a recorded exception`);
    }
  }
  for (const scope of timeline.secrets ?? []) {
    if (!staticLabel(scope.label)) problems.push('a secret scope has an unsafe label');
  }
  for (const mark of timeline.marks ?? []) {
    if (!staticLabel(mark.label) || !NAME.test(mark.wallet ?? '')) problems.push('a chapter mark has an unsafe label');
  }
  return [...new Set(problems)];
}

/**
 * Every tap changes the screen, so the screen it leads to must be held still
 * (a settled or result hold) before the next tap, entry or close on the same
 * window, and before the run ends. Typing does not change the screen; a tap
 * that holds after itself was taken against a timer, so it is not counted as
 * skipping the screen before it.
 */
export function settledAfterEachTap(holds, tracks) {
  const problems = [];
  const byTrack = new Map();
  for (const hold of [...holds].sort((a, b) => a.from - b.from)) {
    if (!tracks.has(hold.track)) {
      problems.push(`the hold "${hold.label}" is on a window the run did not record`);
      continue;
    }
    const pending = byTrack.get(hold.track);
    if (ACTIONS.has(hold.kind) && pending && hold.after !== true) {
      problems.push(`${hold.track}: "${pending.label}" led to a screen with no settled hold before "${hold.label}"`);
    }
    if (hold.kind === 'tap') byTrack.set(hold.track, hold);
    else if (HELD.has(hold.kind) || hold.kind === 'close') byTrack.delete(hold.track);
  }
  for (const [track, pending] of byTrack) {
    problems.push(`${track}: "${pending.label}" led to a screen that was never held`);
  }
  return problems;
}

/** A track as contiguous pieces covering [startedAt, end). */
function trackPieces(track, end) {
  const stop = track.endedAt ?? end;
  const pieces = [];
  const segments = track.segments ?? [];
  if (!segments.length) return [{ from: track.startedAt, to: stop, card: 'Waiting for the first frame' }];
  if (segments[0].from > track.startedAt) pieces.push({ from: track.startedAt, to: segments[0].from, card: 'Waiting for the first frame' });
  segments.forEach((segment, i) => {
    const to = segments[i + 1]?.from ?? stop;
    if (to <= segment.from) return;
    pieces.push(segment.verdict === 'card'
      ? { from: segment.from, to, card: segment.card, redacted: true }
      : { from: segment.from, to, file: segment.file });
  });
  return pieces;
}

function clip(pieces, from, to) {
  return pieces
    .filter((piece) => piece.to > from && piece.from < to)
    .map((piece) => ({ ...piece, from: Math.max(piece.from, from), to: Math.min(piece.to, to) }));
}

/** Fill gaps with a card and merge neighbours that show the same thing. */
function cover(pieces, from, to, gapCard) {
  const out = [];
  let at = from;
  for (const piece of [...pieces].sort((a, b) => a.from - b.from)) {
    if (piece.from > at) out.push({ from: at, to: piece.from, card: gapCard });
    const start = Math.max(piece.from, at);
    if (piece.to > start) out.push({ ...piece, from: start });
    at = Math.max(at, piece.to);
  }
  if (at < to) out.push({ from: at, to, card: gapCard });
  const merged = [];
  for (const piece of out) {
    const last = merged.at(-1);
    if (last && last.file === piece.file && last.card === piece.card && last.redacted === piece.redacted
      && last.to === piece.from) last.to = piece.to;
    else merged.push({ ...piece });
  }
  return merged;
}

/**
 * The lanes to compose, in order: each wallet's page, then its window lane.
 * The window lane follows the secondary window acted on most recently.
 */
export function planLanes(timeline) {
  const start = timeline.startedAt;
  const end = timeline.endedAt;
  const wallets = [...new Set(timeline.tracks.map((track) => track.wallet))]
    .sort((a, b) => (WALLET_ORDER.indexOf(a) + 1 || 99) - (WALLET_ORDER.indexOf(b) + 1 || 99));
  const lanes = [];
  for (const wallet of wallets) {
    const main = timeline.tracks.find((track) => track.wallet === wallet && track.role === 'main');
    if (main) {
      lanes.push({ title: wallet, pieces: cover(clip(trackPieces(main, end), start, end), start, end, main.endedAt ? 'Window closed' : 'Not open yet') });
    }
    const secondary = timeline.tracks.filter((track) => track.wallet === wallet && track.role === 'secondary');
    if (!secondary.length) continue;
    const byDir = new Map(secondary.map((track) => [track.dir, { track, pieces: trackPieces(track, end) }]));
    const focus = (timeline.focus ?? []).filter((event) => byDir.has(event.track)).sort((a, b) => a.at - b.at);
    const cuts = [...new Set([start, end,
      ...secondary.flatMap((track) => [track.startedAt, track.endedAt ?? end]),
      ...focus.map((event) => event.at)])]
      .filter((at) => at >= start && at <= end).sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [from, to] = [cuts[i], cuts[i + 1]];
      const alive = (dir) => {
        const { track } = byDir.get(dir);
        return track.startedAt <= from && from < (track.endedAt ?? end);
      };
      const latest = focus.filter((event) => event.at <= from && alive(event.track)).at(-1);
      if (latest) pieces.push(...clip(byDir.get(latest.track).pieces, from, to));
    }
    lanes.push({ title: `${wallet} windows`, pieces: cover(pieces, start, end, 'No other window open') });
  }
  return lanes;
}

/** Captions: the operation (marks) and the latest action (holds), as time windows. */
export function captionWindows(timeline) {
  const end = timeline.endedAt;
  const windows = (events, text) => {
    const sorted = [...events].sort((a, b) => a.at - b.at);
    const out = [];
    sorted.forEach((event, i) => {
      const to = sorted[i + 1]?.at ?? end;
      const last = out.at(-1);
      if (last && last.text === text(event)) last.to = to;
      else out.push({ from: event.at, to, text: text(event) });
    });
    return out;
  };
  return {
    operations: windows(timeline.marks ?? [], (mark) => `${mark.label}  ·  ${mark.wallet}`),
    actions: windows([
      ...(timeline.holds ?? []).map((hold) => ({ at: hold.from, label: hold.label })),
      // A secret scope reads as the action while its card is up, then the
      // caption falls back to the next hold.
      ...(timeline.secrets ?? []).flatMap((scope) => [
        { at: scope.from, label: `${scope.label} (hidden)` },
        { at: scope.to, label: 'Back on screen' },
      ]),
    ], (event) => event.label),
  };
}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status})`);
}

const seconds = (ms) => (ms / 1000).toFixed(3);
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

async function main() {
  const runDir = resolve(argument('run'));
  const fps = Number(argument('fps', '10'));
  const font = argument('font', '/System/Library/Fonts/Supplemental/Arial Bold.ttf');
  const out = resolve(argument('out', join(runDir, 'encoded')));
  if (!existsSync(font)) throw new Error('caption font not found; pass --font');
  const timeline = JSON.parse(readFileSync(join(runDir, 'timeline.json'), 'utf8'));
  const problems = validateTimeline(timeline, runDir);
  if (problems.length) throw new Error(`refusing to encode:\n  - ${problems.join('\n  - ')}`);

  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const work = join(out, 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const lanes = planLanes(timeline);
  const { operations, actions } = captionWindows(timeline);
  const start = timeline.startedAt;
  const duration = (timeline.endedAt - start) / 1000;

  // Frames are 760x1200 (380x600 at 2x); cards match.
  // A redaction card says so; a placeholder (no window open yet) does not.
  const cards = new Map();
  const cardFile = (label, redacted) => {
    const key = `${redacted ? 'hidden' : 'placeholder'}:${label}`;
    if (!cards.has(key)) {
      const file = join(work, `card-${cards.size}.jpg`);
      const text = join(work, `card-${cards.size}.txt`);
      writeFileSync(text, redacted ? `${label}\n\nHidden by the capture guard` : label, { mode: 0o600 });
      ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x15131d:s=760x1200', '-frames:v', '1', '-vf',
        `drawtext=fontfile='${font}':textfile='${text}':expansion=none:fontcolor=0xf5c542:fontsize=34:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2`,
        file]);
      cards.set(key, file);
    }
    return cards.get(key);
  };
  const pieceFile = (piece) => (piece.file ? join(runDir, piece.file) : cardFile(piece.card, piece.redacted === true));

  const inputs = [];
  lanes.forEach((lane, i) => {
    const list = ['ffconcat version 1.0'];
    for (const piece of lane.pieces) list.push(`file '${pieceFile(piece)}'`, `duration ${seconds(piece.to - piece.from)}`);
    // The concat demuxer needs the last entry repeated for its duration to count.
    list.push(`file '${pieceFile(lane.pieces.at(-1))}'`);
    const listFile = join(work, `lane-${i}.ffconcat`);
    writeFileSync(listFile, `${list.join('\n')}\n`, { mode: 0o600 });
    inputs.push('-f', 'concat', '-safe', '0', '-i', listFile);
  });

  const W = 1920;
  const H = 1080;
  const BAR = 120;
  const gap = 16;
  const tileW = Math.floor((W - gap * (lanes.length + 1)) / lanes.length);
  const tileH = Math.min(H - BAR - 70, Math.floor(tileW * 1200 / 760));
  const top = BAR + 40;
  const textFile = (name, text) => {
    const file = join(work, name);
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  };
  const filters = [`color=c=0x0d0b14:s=${W}x${H}:r=${fps}:d=${duration.toFixed(3)}[bg]`];
  lanes.forEach((_, i) => {
    filters.push(`[${i}:v]fps=${fps},scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=0x0d0b14,setsar=1[l${i}]`);
  });
  let last = 'bg';
  lanes.forEach((lane, i) => {
    const x = gap + i * (tileW + gap);
    filters.push(`[${last}][l${i}]overlay=x=${x}:y=${top}:eof_action=repeat[o${i}]`);
    last = `o${i}`;
  });
  const draw = [];
  lanes.forEach((lane, i) => {
    const x = gap + i * (tileW + gap);
    draw.push(`drawtext=fontfile='${font}':textfile='${textFile(`title-${i}.txt`, lane.title)}':expansion=none:fontcolor=0xbbbbcc:fontsize=24:x=${x}+(${tileW}-text_w)/2:y=${top - 32}`);
  });
  operations.forEach((window, i) => {
    draw.push(`drawtext=fontfile='${font}':textfile='${textFile(`operation-${i}.txt`, window.text)}':expansion=none:fontcolor=0xffffff:fontsize=40:x=40:y=22:enable='between(t,${seconds(window.from - start)},${seconds(window.to - start)})'`);
  });
  actions.forEach((window, i) => {
    draw.push(`drawtext=fontfile='${font}':textfile='${textFile(`action-${i}.txt`, `Action: ${window.text}`)}':expansion=none:fontcolor=0xf5c542:fontsize=28:x=40:y=74:enable='between(t,${seconds(window.from - start)},${seconds(window.to - start)})'`);
  });
  draw.push(`drawtext=fontfile='${font}':text='%{pts\\:gmtime\\:${Math.floor(start / 1000)}\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S} UTC':fontcolor=0xffffff:fontsize=34:x=w-text_w-40:y=30`);
  draw.push(`drawtext=fontfile='${font}':text='G-premium  ·  1.0x  ·  Smirk Wallet v${/^\d+\.\d+\.\d+$/.test(timeline.version ?? '') ? timeline.version : '0.3.1'}':expansion=none:fontcolor=0x777788:fontsize=22:x=w-text_w-40:y=80`);
  filters.push(`[${last}]${draw.join(',')},format=yuv420p[v]`);
  const graph = join(work, 'graph.txt');
  writeFileSync(graph, filters.join(';\n'), { mode: 0o600 });

  const video = join(out, 'G-premium.mp4');
  // The graph is too long for one argument; FFmpeg 7 reads it from a file with
  // `-/filter_complex`, older releases with `-filter_complex_script`.
  const major = Number(/version n?(\d+)/.exec(spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? 0);
  const graphOption = major >= 7 ? ['-/filter_complex', graph] : ['-filter_complex_script', graph];
  ffmpeg([...inputs, ...graphOption, '-map', '[v]', '-r', String(fps), '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20', '-movflags', '+faststart', video]);
  chmodSync(video, 0o600);

  const chapters = ['# G-premium chapters', '', `Run started ${new Date(start).toISOString()}; played at 1.0x with no trimming.`, '',
    '| Offset | UTC | Operation |', '| --- | --- | --- |',
    ...operations.map((window) => {
      const offset = new Date(window.from - start).toISOString().slice(11, 19);
      return `| ${offset} | ${clock(window.from)} | ${window.text} |`;
    })];
  writeFileSync(join(out, 'CHAPTERS-G-premium.md'), `${chapters.join('\n')}\n`, { mode: 0o600 });
  console.log(`Encoded ${lanes.length} lanes, ${duration.toFixed(0)} s at 1.0x, into ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`G-premium footage: ${String(error.message)}`);
    process.exit(1);
  });
}
