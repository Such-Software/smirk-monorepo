#!/usr/bin/env node
/**
 * Encode the B lane's guarded footage into video, at 1.0x with nothing
 * trimmed: the dead air the owner asked for stays in.
 *
 *   node packages/e2e/scripts/B-send-receive-history-footage.mjs \
 *     --run ~/Build/smirk-e2e/v0.3.1-run-11204 [--font <ttf>] [--fps 10]
 *
 * Input: <run>/footage/B-send-receive-history/<recorder>/{frames.jsonl,
 * timeline.jsonl, frames/*.jpg} written by the lane's guarded recorder, and
 * manifest.json with the hold policy it ran under.
 *
 * Refuses, before writing anything:
 *   - a frame row without a guard verdict, a "clean" row without its image,
 *     or a redaction card whose label is not static text;
 *   - any tap or field entry held less than the policy's 6 s, any settled
 *     screen less than 12 s, any key result less than 25 s;
 *   - a tap or field entry whose screen was never held: there must be a
 *     settled or result hold since the previous tap or entry (or since the
 *     recorder or a secret scope started). The single exception is an urgent
 *     tap on a screen that counts itself down (reason "countdown"), which
 *     must be followed directly by a settled hold.
 * Reports, without refusing, holds during which the screen still changed
 * (new frames after the first second), so a moving "static" screen is seen.
 *
 * Output (0700 directory, 0600 files) in <run>/footage/B-send-receive-history/video:
 *   alice.mp4, bob.mp4, carol.mp4, popups.mp4   one column each, real time
 *   B-send-receive-history.mp4                  the four columns side by side,
 *                                               a title bar with a UTC clock and a
 *                                               caption bar (operation per wallet),
 *                                               with chapters
 *   CHAPTERS.md                                 chapter list: offset, UTC, wallet, label
 * Promotion is manual. Nothing is uploaded anywhere.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LANE = 'B-send-receive-history';
const WALLETS = ['alice', 'bob', 'carol'];
const COLUMN = { w: 608, h: 960 };
const TOP = 44;
const BOTTOM = 84;
const SLACK_MS = 250;
const STATIC_LABEL = /^[A-Za-z][A-Za-z0-9 ,.:;()'/+&-]{0,90}$/;
/** The fixture's `assertStaticLabel`, again: short text, no long alphanumeric run, no URL. */
const isStaticLabel = (label) =>
  typeof label === 'string' && STATIC_LABEL.test(label) && !/[A-Za-z0-9]{16,}/.test(label) && !label.includes('://');

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
}

function hasFilter(name) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return new RegExp(`\\s${name}\\s`).test(r.stdout ?? '');
}

const escText = (t) => t.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:').replace(/%/g, '\\%');

/** The only reason a tap may skip its pause. */
const URGENT_REASONS = new Set(['countdown']);

export function verify(root, recorders, policy) {
  const problems = [];
  const minimum = { tap: policy.holdBeforeTapMs, fill: policy.holdBeforeTapMs, settled: policy.holdSettledMs, result: policy.holdResultMs };
  for (const r of recorders) {
    for (const [i, row] of r.rows.entries()) {
      if (typeof row.at !== 'number' || !['frame', 'same', 'card'].includes(row.kind)) problems.push(`${r.name}: frame row ${i + 1} is malformed`);
      else if (!['clean', 'redacted'].includes(row.verdict)) problems.push(`${r.name}: frame row ${i + 1} has no guard verdict`);
      else if (row.kind === 'frame' && (row.verdict !== 'clean' || !existsSync(join(root, r.name, 'frames', row.file ?? '')))) {
        problems.push(`${r.name}: frame row ${i + 1} is not a clean, present image`);
      } else if (row.kind === 'card' && (row.verdict !== 'redacted' || !isStaticLabel(row.label))) {
        problems.push(`${r.name}: card row ${i + 1} is not a static redaction label`);
      }
    }
    // `held`: the screen on show had a settled or result hold since the last
    // tap or entry. A new recorder session or a secret scope starts unheld.
    let held = false;
    let afterUrgent = null;
    for (const ev of r.timeline) {
      if (!isStaticLabel(ev.label)) problems.push(`${r.name}: a timeline label is not static text`);
      if (afterUrgent && ['tap', 'fill', 'settled', 'result'].includes(ev.kind)) {
        if (ev.kind !== 'settled') problems.push(`${r.name}: urgent tap "${afterUrgent}" is not followed by a settled hold`);
        afterUrgent = null;
      }
      if (ev.kind === 'session' || ev.kind === 'secret-end') {
        held = false;
        continue;
      }
      if (ev.kind === 'settled' || ev.kind === 'result') {
        if (!(ev.holdMs >= minimum[ev.kind] - SLACK_MS)) {
          problems.push(`${r.name}: ${ev.kind} "${ev.label}" held ${ev.holdMs ?? 0} ms, policy ${minimum[ev.kind]} ms`);
        }
        held = true;
        continue;
      }
      if (ev.kind !== 'tap' && ev.kind !== 'fill') continue;
      if (ev.urgent !== undefined) {
        if (ev.kind !== 'tap' || !URGENT_REASONS.has(ev.urgent)) problems.push(`${r.name}: ${ev.kind} "${ev.label}" claims an unknown urgency`);
        afterUrgent = ev.label;
      } else {
        if (!(ev.holdMs >= minimum[ev.kind] - SLACK_MS)) {
          problems.push(`${r.name}: ${ev.kind} "${ev.label}" held ${ev.holdMs ?? 0} ms, policy ${minimum[ev.kind]} ms`);
        }
        if (!held) problems.push(`${r.name}: ${ev.kind} "${ev.label}" acted on a screen that was never held`);
      }
      held = false;
    }
    if (afterUrgent) problems.push(`${r.name}: urgent tap "${afterUrgent}" is not followed by a settled hold`);
  }
  return problems;
}

/**
 * Holds during which the screen still changed: a new frame after the first
 * second of a settled or result hold. Reported, not refused: an animation
 * the wallet runs on a settled screen is worth seeing, not worth discarding
 * a multi-hour run over.
 */
export function movingHolds(recorders) {
  const out = [];
  for (const r of recorders) {
    const frames = r.rows.filter((row) => row.kind === 'frame').map((row) => row.at);
    for (const ev of r.timeline) {
      if ((ev.kind !== 'settled' && ev.kind !== 'result') || !(ev.holdMs > 0)) continue;
      const from = ev.at - ev.holdMs + 1000;
      const changes = frames.filter((at) => at > from && at <= ev.at).length;
      if (changes > 0) out.push({ recorder: r.name, kind: ev.kind, label: ev.label, changes });
    }
  }
  return out;
}

/** Labels for a column with nothing to show yet; drawn without the "Redacted" headline. */
const IDLE = new Set(['Not started yet', 'No popup open']);

function cardImage(cardsDir, label, font) {
  const file = join(cardsDir, `${createHash('sha256').update(label).digest('hex').slice(0, 16)}.jpg`);
  if (existsSync(file)) return file;
  const W = COLUMN.w * 2;
  const H = COLUMN.h * 2;
  const draw = [
    ...(IDLE.has(label) ? [] : [`drawtext=fontfile='${font}':text='Redacted':fontcolor=0xf5c542:fontsize=64:x=(w-text_w)/2:y=h/2-90`]),
    `drawtext=fontfile='${font}':text='${escText(label)}':fontcolor=0xffffff:fontsize=34:x=(w-text_w)/2:y=h/2+10`,
  ].join(',');
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x1d1b26:s=${W}x${H}`, '-vf', draw, '-frames:v', '1', '-q:v', '3', file]);
  return file;
}

/** One column's image timeline: [{ at, image }] from frames, cards and pre-recording spans. */
function events(root, r, cardsDir, font) {
  const out = [];
  for (const ev of r.timeline) {
    if (ev.kind === 'secret-span' && typeof ev.from === 'number') out.push({ at: ev.from, image: cardImage(cardsDir, ev.label, font) });
  }
  for (const row of r.rows) {
    if (row.kind === 'frame') out.push({ at: row.at, image: join(root, r.name, 'frames', row.file) });
    else if (row.kind === 'card') out.push({ at: row.at, image: cardImage(cardsDir, row.label, font) });
  }
  if (r.endCard && r.rows.length) out.push({ at: r.rows.at(-1).at + 1000, image: cardImage(cardsDir, r.endCard, font) });
  return out.sort((a, b) => a.at - b.at);
}

function encodeColumn(name, evs, t0, t1, cardsDir, font, fps, outDir, idle) {
  const seq = [{ at: t0, image: cardImage(cardsDir, idle, font) }, ...evs.filter((e) => e.at >= t0)];
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < seq.length; i++) {
    const end = i + 1 < seq.length ? seq[i + 1].at : t1;
    const duration = Math.max(0, end - seq[i].at) / 1000;
    if (duration <= 0 && i + 1 < seq.length) continue;
    lines.push(`file '${seq[i].image.replace(/'/g, "'\\''")}'`, `duration ${duration.toFixed(3)}`);
  }
  // The concat demuxer ignores the last entry's duration, so it is repeated;
  // -t then pins every column to exactly the run's length.
  lines.push(`file '${seq.at(-1).image.replace(/'/g, "'\\''")}'`, 'duration 0.100');
  const list = join(outDir, `${name}.ffconcat`);
  writeFileSync(list, `${lines.join('\n')}\n`, { mode: 0o600 });
  const out = join(outDir, `${name}.mp4`);
  ffmpeg([
    // Cards, wallet pages and popups differ in size. Rebuilding the filter
    // graph on a size change restarts the fps filter and drops time, so keep
    // one graph and let scale absorb the change.
    '-reinit_filter', '0',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `scale=${COLUMN.w}:${COLUMN.h}:force_original_aspect_ratio=decrease,pad=${COLUMN.w}:${COLUMN.h}:(ow-iw)/2:(oh-ih)/2:color=0x0d0b14,fps=${fps},format=yuv420p`,
    '-t', ((t1 - t0) / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', out,
  ]);
  // B_FOOTAGE_KEEP_LISTS=1 keeps the concat lists (paths and durations only) for debugging.
  if (!process.env.B_FOOTAGE_KEEP_LISTS) rmSync(list, { force: true });
  chmodSync(out, 0o600);
  return out;
}

const ts = (ms) => {
  const s = Math.max(0, ms) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return { h, m, sec };
};
const assTime = (ms) => {
  const { h, m, sec } = ts(ms);
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const hms = (ms) => {
  const { h, m, sec } = ts(ms);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}`;
};

function captions(columns, t0, t1, gridW) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${gridW}`, `PlayResY: ${TOP + COLUMN.h + BOTTOM}`, 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];
  columns.forEach((c, i) => {
    const left = i * COLUMN.w + 12;
    const right = gridW - (i + 1) * COLUMN.w + 12;
    head.push(`Style: C${i},Arial,22,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,1,${left},${right},14,1`);
  });
  head.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  const shown = new Set(['tap', 'fill', 'settled', 'result', 'hold', 'mark', 'secret-start']);
  columns.forEach((c, i) => {
    const evs = c.timeline.filter((e) => shown.has(e.kind)).sort((a, b) => a.at - b.at);
    evs.forEach((e, j) => {
      const start = e.at - t0;
      const end = Math.min((evs[j + 1]?.at ?? t1) - t0, start + 60_000);
      const text = `${c.title}: ${e.label}`.replace(/[{}\\]/g, '');
      head.push(`Dialogue: 0,${assTime(start)},${assTime(end)},C${i},,0,0,0,,${text}`);
    });
  });
  return `${head.join('\n')}\n`;
}

function main() {
  const run = resolve(argument('run'));
  const fps = Number(argument('fps', '10'));
  const font = argument('font', ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find((f) => existsSync(f)));
  if (!font || !existsSync(font)) throw new Error('caption font not found; pass --font');
  const root = join(run, 'footage', LANE);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const policy = manifest.policy;
  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'frames.jsonl')))
    .map((d) => d.name);
  if (!WALLETS.every((w) => names.includes(w))) throw new Error('footage for alice, bob and carol is required');
  const recorders = names.map((name) => ({
    name,
    rows: readJsonl(join(root, name, 'frames.jsonl')),
    timeline: readJsonl(join(root, name, 'timeline.jsonl')),
  }));

  const problems = verify(root, recorders, policy);
  if (problems.length) {
    console.error(`Refusing to encode: ${problems.length} problem(s)\n${problems.slice(0, 50).map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  const moving = movingHolds(recorders);
  if (moving.length) {
    const held = recorders.reduce((n, r) => n + r.timeline.filter((e) => e.kind === 'settled' || e.kind === 'result').length, 0);
    console.warn(
      `Note: ${moving.length} of ${held} holds showed screen changes after their first second:\n` +
        moving.slice(0, 20).map((m) => `  ${m.recorder}: ${m.kind} "${m.label}" (${m.changes} new frame(s))`).join('\n'),
    );
  }

  const outDir = privateDir(join(root, 'video'));
  const cardsDir = privateDir(join(outDir, 'cards'));
  const times = recorders.flatMap((r) => [...r.rows.map((x) => x.at), ...r.timeline.map((e) => e.from ?? e.at)]);
  const t0 = Math.min(...times);
  const t1 = Math.max(...recorders.flatMap((r) => r.rows.map((x) => x.at))) + 2000;

  const columns = WALLETS.map((w) => ({ title: w, ...recorders.find((r) => r.name === w) }));
  // Approval windows, the shop and explorer tabs share one column, in time order.
  const popupRecorders = recorders.filter((r) => !WALLETS.includes(r.name)).map((r) => ({ ...r, endCard: 'No popup open' }));
  const popupColumn = { title: 'popups', name: 'popups', rows: [], timeline: popupRecorders.flatMap((r) => r.timeline) };

  const files = columns.map((c) => encodeColumn(c.name, events(root, c, cardsDir, font), t0, t1, cardsDir, font, fps, outDir, 'Not started yet'));
  const popupEvents = popupRecorders.flatMap((r) => events(root, r, cardsDir, font)).sort((a, b) => a.at - b.at);
  files.push(encodeColumn('popups', popupEvents, t0, t1, cardsDir, font, fps, outDir, 'No popup open'));

  const gridW = COLUMN.w * 4;
  const all = [...columns, popupColumn];
  const assFile = join(outDir, 'captions.ass');
  writeFileSync(assFile, captions(all, t0, t1, gridW), { mode: 0o600 });

  // Chapters: every "mark" (one per payment), on any column.
  const marks = all.flatMap((c) => c.timeline.filter((e) => e.kind === 'mark').map((e) => ({ ...e, title: c.title }))).sort((a, b) => a.at - b.at);
  const meta = [';FFMETADATA1', `title=Smirk ${manifest.extensionVersion ?? ''} live e2e: sends, receives and history`];
  // A chapter at zero: ffmpeg rebases chapter times on the first one.
  meta.push('[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', `END=${Math.max(1, (marks[0]?.at ?? t1) - t0)}`, 'title=Wallets ready');
  marks.forEach((m, i) => {
    const start = m.at - t0;
    const end = (marks[i + 1]?.at ?? t1) - t0;
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${Math.max(end, start + 1)}`, `title=${m.title}: ${m.label}`);
  });
  const metaFile = join(outDir, 'chapters.ffmeta');
  writeFileSync(metaFile, `${meta.join('\n')}\n`, { mode: 0o600 });

  const t0s = Math.floor(t0 / 1000);
  const titles = all
    .map((c, i) => `drawtext=fontfile='${font}':text='${escText(c.title)}':fontcolor=0xf5c542:fontsize=26:x=${i * COLUMN.w + 16}:y=9`)
    .join(',');
  const clock = `drawtext=fontfile='${font}':text='%{pts\\:gmtime\\:${t0s}} UTC':fontcolor=0xffffff:fontsize=26:x=w-text_w-16:y=9`;
  const burn = hasFilter('subtitles') ? `,subtitles='${assFile.replace(/'/g, "\\'").replace(/:/g, '\\:')}'` : '';
  const grid = join(outDir, `${LANE}.mp4`);
  ffmpeg([
    ...files.flatMap((f) => ['-i', f]),
    '-i', metaFile,
    '-filter_complex',
    `[0:v][1:v][2:v][3:v]hstack=inputs=4:shortest=1,pad=iw:ih+${TOP + BOTTOM}:0:${TOP}:color=0x0d0b14,${titles},${clock}${burn},format=yuv420p[v]`,
    '-map', '[v]', '-map_metadata', '4', '-map_chapters', '4',
    '-t', ((t1 - t0) / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', grid,
  ]);
  chmodSync(grid, 0o600);

  const chapters = [
    `# ${LANE} footage`,
    '',
    `Run: ${run}. Extension ${manifest.extensionVersion ?? 'unknown'}. Real time (1.0x), nothing trimmed. Started ${new Date(t0).toISOString()}.`,
    '',
    '| Offset | UTC | Wallet | Chapter |',
    '| --- | --- | --- | --- |',
    ...marks.map((m) => `| ${hms(m.at - t0)} | ${new Date(m.at).toISOString().slice(11, 19)} | ${m.title} | ${m.label} |`),
    '',
  ];
  writeFileSync(join(outDir, 'CHAPTERS.md'), chapters.join('\n'), { mode: 0o600 });
  console.log(`Encoded ${files.length} columns and ${LANE}.mp4 (${hms(t1 - t0)}, ${marks.length} chapters) in ${outDir}`);
}

// Importable for its checks (scripts/B-send-receive-history-footage.test.mjs);
// encodes only when run directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`footage encode refused: ${String(error?.message ?? error).split('\n')[0]}`);
    process.exit(1);
  }
}
