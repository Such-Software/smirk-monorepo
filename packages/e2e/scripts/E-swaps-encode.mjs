#!/usr/bin/env node
/**
 * Encode the E-swaps live lane's guarded frames into video, at 1.0x, with no
 * trimming: every hold the run made stays on screen for as long as it lasted.
 *
 * Input: <area>/<wallet>/timeline.json and frames/ (fixtures/E-swaps-footage.ts).
 * Output, in <area> (0700, files 0600):
 *   E-swaps-<wallet>.mp4    the wallet's column with a caption bar (test,
 *                           operation, wallet, UTC clock);
 *   CHAPTERS-E-swaps.md     one line per test with its start offset.
 *
 * Refusals, each before any video is written:
 *   - a frame without a guard verdict of clean or masked, or a missing file;
 *   - a hold shorter than the owner's policy for its kind;
 *   - a label that is not static words.
 * Secret scopes and card intervals render as a labelled redaction card.
 * Nothing is uploaded or promoted; copying a video anywhere is a manual step.
 *
 * Usage: node packages/e2e/scripts/E-swaps-encode.mjs [--area <dir>] [--font <ttf>]
 * Default area: ~/Build/smirk-e2e/<E2E_RUN_LABEL or v0.3.1-run-11204>/footage/E-swaps
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertStaticLabel } from '../fixtures/E-swaps-guard.mjs';

const POLICY_MS = { tap: 6_000, type: 6_000, settled: 12_000, result: 25_000 };
const FRAME = { w: 760, h: 1200 };
const BAR = 150;

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

/** Every reason this timeline must not become video. Empty means admissible. */
export function refusals(timeline, framesDir) {
  const out = [];
  if (timeline.version !== 1 || timeline.area !== 'E-swaps') out.push('not an E-swaps timeline');
  for (const f of timeline.frames ?? []) {
    if (f.verdict !== 'clean' && f.verdict !== 'masked') out.push(`frame ${f.file} has no guard verdict`);
    if (framesDir && !existsSync(join(framesDir, f.file))) out.push(`frame ${f.file} is missing`);
  }
  for (const h of timeline.holds ?? []) {
    const need = POLICY_MS[h.kind];
    if (need === undefined) out.push(`hold of unknown kind ${String(h.kind).slice(0, 20)}`);
    else if (h.until - h.from < need || h.requiredMs < need) out.push(`a ${h.kind} hold lasted ${h.until - h.from} ms, under the ${need} ms policy`);
  }
  for (const label of [...(timeline.markers ?? []).map((m) => m.label), ...(timeline.holds ?? []).map((h) => h.label)]) {
    try {
      assertStaticLabel(label);
    } catch {
      out.push('a label is not static words');
    }
  }
  for (const s of timeline.segments ?? []) {
    if (s.kind !== 'test') {
      try {
        assertStaticLabel(s.label);
      } catch {
        out.push('a segment label is not static words');
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The picture at every moment: frames, overridden by secret scopes and card
 * intervals. Returns [{ at, image }] in time order; each holds until the next.
 */
export function storyboard(timeline, cardImage) {
  const frames = [...timeline.frames].sort((a, b) => a.from - b.from);
  const redacted = timeline.segments.filter((s) => s.kind === 'secret' || s.kind === 'card');
  const inRedaction = (t) => redacted.some((r) => t >= r.from && t <= r.until);
  const events = [];
  // A frame captured inside a redacted interval never shows (there should be
  // none: the recorder pauses), so drop it rather than trust the order.
  for (const f of frames) if (!inRedaction(f.from)) events.push({ at: f.from, image: { frame: f.file }, until: f.until, rank: 0 });
  for (const r of redacted) {
    events.push({ at: r.from, image: { card: cardImage(r.label) }, until: r.until, rank: 1 });
    // Frames are stored once per change, so the screen that was showing when
    // the redaction ends may be a run that started before it: show it again.
    if (inRedaction(r.until + 1)) continue;
    const run = frames.filter((f) => f.from <= r.until).at(-1);
    if (run && run.until >= r.until) events.push({ at: r.until, image: { frame: run.file }, until: run.until, rank: 0 });
  }
  return events.sort((a, b) => a.at - b.at || b.rank - a.rank);
}

/** Captions: the latest operation label, within the latest test. */
function captions(timeline) {
  const ops = [
    ...timeline.markers.map((m) => ({ at: m.at, text: m.label })),
    ...timeline.holds.map((h) => ({ at: h.from, text: h.label })),
    ...timeline.segments.filter((s) => s.kind === 'secret' || s.kind === 'card').map((s) => ({ at: s.from, text: `redacted: ${s.label}` })),
  ].sort((a, b) => a.at - b.at);
  const tests = timeline.segments.filter((s) => s.kind === 'test').sort((a, b) => a.from - b.from);
  const testAt = (t) => tests.filter((s) => s.from <= t).at(-1)?.label ?? 'setup';
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const from = ops[i].at;
    const until = ops[i + 1]?.at ?? (timeline.stoppedAt ?? from + 1_000);
    if (until <= from) continue;
    out.push({ from, until, text: `${testAt(from)}\n${ops[i].text}` });
  }
  return out;
}

const srtTime = (ms) => {
  const t = Math.max(0, Math.round(ms));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
};

function encodeWallet(areaDir, wallet, font) {
  const dir = join(areaDir, wallet);
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
  const framesDir = join(dir, 'frames');
  const problems = refusals(timeline, framesDir);
  if (problems.length) throw new Error(`refusing ${wallet}: ${problems.slice(0, 5).join('; ')}`);
  if (timeline.frames.length === 0) throw new Error(`refusing ${wallet}: no frames`);

  const work = join(dir, 'encode');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const cards = new Map();
  const cardImage = (label) => {
    if (!cards.has(label)) {
      const file = join(work, `card-${cards.size}.jpg`);
      const text = `Redacted\n\n${label}`.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
      ffmpeg(['-f', 'lavfi', '-i', `color=c=0x15131c:s=${FRAME.w}x${FRAME.h}`, '-frames:v', '1',
        '-vf', `drawtext=fontfile='${font}':text='${text}':fontcolor=0xf5c542:fontsize=44:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2`, file]);
      cards.set(label, file);
    }
    return cards.get(label);
  };
  const board = storyboard(timeline, cardImage);
  const start = board[0].at;
  const end = Math.max(timeline.stoppedAt ?? 0, board.at(-1).until ?? 0, board.at(-1).at + 1_000);

  // Concat list: each image holds until the next one starts (dead air kept).
  const list = [];
  board.forEach((item, i) => {
    const next = board[i + 1]?.at ?? end;
    const seconds = Math.max(0.001, (next - item.at) / 1000);
    const file = item.image.frame ? join(framesDir, item.image.frame) : item.image.card;
    list.push(`file '${file.replace(/'/g, "'\\''")}'`, `duration ${seconds.toFixed(3)}`);
  });
  const last = board.at(-1);
  list.push(`file '${(last.image.frame ? join(framesDir, last.image.frame) : last.image.card).replace(/'/g, "'\\''")}'`);
  writeFileSync(join(work, 'list.txt'), `${list.join('\n')}\n`, { mode: 0o600 });

  const srt = captions(timeline)
    .map((c, i) => `${i + 1}\n${srtTime(c.from - start)} --> ${srtTime(c.until - start)}\n${c.text}\n`)
    .join('\n');
  writeFileSync(join(work, 'captions.srt'), srt, { mode: 0o600 });

  const clock = `drawtext=fontfile='${font}':text='${wallet}   %{pts\\:gmtime\\:${Math.floor(start / 1000)}\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S} UTC':fontcolor=0xffffff:fontsize=26:x=24:y=h-44`;
  const graph = [
    `scale=${FRAME.w}:${FRAME.h}:force_original_aspect_ratio=decrease`,
    `pad=${FRAME.w}:${FRAME.h}:(ow-iw)/2:(oh-ih)/2:color=0x0d0b14`,
    `pad=${FRAME.w}:${FRAME.h + BAR}:0:0:color=0x0d0b14`,
    'fps=30',
    `subtitles=${join(work, 'captions.srt').replace(/([:\\',])/g, '\\$1')}:force_style='Alignment=1,MarginL=12,MarginV=13,Fontsize=8,PrimaryColour=&H00FFFFFF&,BorderStyle=1,Outline=0,Shadow=0'`,
    clock,
    'format=yuv420p',
  ].join(',');
  const outFile = join(areaDir, `E-swaps-${wallet}.mp4`);
  // -reinit_filter 0: cards and frames may differ in size or pixel format, and
  // a filter reinit would restart the timeline (the video came out short).
  ffmpeg(['-f', 'concat', '-safe', '0', '-reinit_filter', '0', '-i', join(work, 'list.txt'), '-vf', graph, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', outFile]);
  chmodSync(outFile, 0o600);
  // Diagnostics only: the work files hold labels and frame names, no values.
  if (!process.env.E_SWAPS_KEEP_ENCODE) rmSync(work, { recursive: true, force: true });
  const tests = timeline.segments.filter((s) => s.kind === 'test').sort((a, b) => a.from - b.from);
  return { outFile, start, end, tests };
}

function main() {
  const label = process.env.E2E_RUN_LABEL ?? 'v0.3.1-run-11204';
  const areaDir = resolve(argument('area', process.env.E2E_FOOTAGE_DIR ? join(process.env.E2E_FOOTAGE_DIR, 'E-swaps') : join(homedir(), 'Build', 'smirk-e2e', label, 'footage', 'E-swaps')));
  const font = argument('font', ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync) ?? '');
  if (!font || !existsSync(font)) throw new Error('caption font not found; pass --font');
  const wallets = readdirSync(areaDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(areaDir, d.name, 'timeline.json')))
    .map((d) => d.name);
  if (wallets.length === 0) throw new Error('no wallet timelines in the area directory');
  const chapters = ['# E-swaps chapters', ''];
  for (const wallet of wallets) {
    const { outFile, start, tests } = encodeWallet(areaDir, wallet, font);
    chapters.push(`## ${wallet}: ${outFile.split('/').pop()}`, '');
    for (const t of tests) {
      const s = Math.round((t.from - start) / 1000);
      const stamp = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      chapters.push(`- ${stamp} ${t.label} (${Math.round((t.until - t.from) / 60_000)} min)`);
    }
    chapters.push('');
    console.log(`encoded ${wallet}`);
  }
  writeFileSync(join(areaDir, 'CHAPTERS-E-swaps.md'), chapters.join('\n'), { mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`E-swaps encode refused: ${String(error.message).split('\n')[0]}`);
    process.exit(1);
  }
}
