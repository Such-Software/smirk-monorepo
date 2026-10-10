#!/usr/bin/env node
/**
 * C-tips encode: turn the guarded recorder's frames into video that keeps
 * every second of dead air, then prove each hold is in the output.
 *
 * The recorder (fixtures/C-tips-footage.ts) stores each distinct frame once,
 * with the wall-clock span it was on screen, per page and per worker session.
 * This builds an ffmpeg concat list per page in which each image lasts exactly
 * until the next one appeared, encodes it at variable frame rate (a still
 * screen is one frame however long it holds), and joins sessions in time order
 * with a dark frame over the gap a worker restart leaves. It never trims, cuts
 * or speeds anything up: that is scripts/process-footage.mjs, whose dead-air
 * trimming is the opposite of this lane's policy, so it must not touch C-tips
 * footage.
 *
 * Outputs, under footage/video/C-tips/<invocation>/ (0700, files 0600):
 *   <page>.mp4         one per recorded page (alice, bob, carol, tabs, bob-fed)
 *   C-tips-all.mp4     alice, bob and carol side by side on one clock, with chapters
 *   C-tips-video.json  the hold check: every hold, where it sits in its page's video
 *
 * The hold check reads the ENCODED video back (ffprobe frame timestamps), not
 * the input: a hold passes only when its page's video shows one unchanged frame
 * for the whole hold window. Holds the recorder already marked not static, a
 * policy below the owner's (6 s tap, 12 s settled, 25 s result), and any session
 * without a timeline all fail the check.
 *
 * Usage:
 *   node scripts/C-tips-encode.mjs --invocation <id>   (C_TIPS_INVOCATION otherwise)
 *   --allow-test-policy   accept a shortened hold policy (offline tests only)
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OWNER_POLICY, invocationId, privateDir, rawRoot, videoRoot } from '../fixtures/C-tips-run.mjs';

/** Seconds of slack for timestamp rounding at a hold's edges. */
const EDGE_S = 0.12;
const MAIN_PAGES = ['alice', 'bob', 'carol'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  return result;
}

/** ffmpeg 5.1+ takes -fps_mode; older builds only -vsync. */
function vfrArgs() {
  const help = run('ffmpeg', ['-hide_banner', '-h', 'full']);
  return /fps_mode/.test(help.stdout) ? ['-fps_mode', 'vfr'] : ['-vsync', 'vfr'];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** One dark frame the size of the recorded pages, for gaps and lead-ins. */
function gapFrame(dir, width, height) {
  const file = join(dir, `gap-${width}x${height}.jpg`);
  if (existsSync(file)) return file;
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x0d0b14:s=${width}x${height}`, '-frames:v', '1', file]);
  if (r.status !== 0) throw new Error(`ffmpeg could not draw the gap frame: ${r.stderr.trim().slice(0, 300)}`);
  chmodSync(file, 0o600);
  return file;
}

/** Load every session of an invocation: lane files, page timelines, frame paths. */
export function loadInvocation(root, invocation) {
  const base = join(root, invocation);
  if (!existsSync(base)) return { sessions: [], problems: [`no footage for invocation ${invocation}`] };
  const sessions = [];
  const problems = [];
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    const laneFile = join(dir, 'lane.json');
    if (!existsSync(laneFile)) {
      problems.push(`session ${name} has no lane.json (its worker did not close cleanly)`);
      continue;
    }
    const lane = readJson(laneFile);
    const pages = {};
    for (const page of lane.pages ?? []) {
      const timelineFile = join(dir, page, 'timeline.json');
      if (!existsSync(timelineFile)) {
        problems.push(`session ${name} page ${page} has no timeline.json`);
        continue;
      }
      const timeline = readJson(timelineFile);
      pages[page] = timeline.frames.map((f) => ({ ...f, path: join(dir, page, f.file) }));
    }
    sessions.push({ name, dir, lane, pages });
  }
  sessions.sort((a, b) => a.lane.startedAt - b.lane.startedAt);
  return { sessions, problems };
}

/**
 * A page's frames across sessions, in time order, with a gap frame wherever a
 * session ended before the next began. `startAt`/`endAt` pad the page out to a
 * shared clock (the side-by-side video) with gap frames.
 */
function pageTrack(sessions, page, gap, startAt, endAt) {
  const track = [];
  for (const session of sessions) {
    const frames = session.pages[page];
    if (!frames?.length) continue;
    const last = track.at(-1);
    if (last && frames[0].from - last.to > 2_000) track.push({ path: gap, from: last.to, to: frames[0].from, gap: true });
    track.push(...frames);
  }
  if (!track.length) return track;
  if (startAt !== undefined && track[0].from > startAt) track.unshift({ path: gap, from: startAt, to: track[0].from, gap: true });
  if (endAt !== undefined && track.at(-1).to < endAt) track.push({ path: gap, from: track.at(-1).to, to: endAt, gap: true });
  return track;
}

/** An ffconcat list where each image lasts until the next one appeared. */
function concatList(track) {
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < track.length; i++) {
    const frame = track[i];
    const until = i + 1 < track.length ? track[i + 1].from : Math.max(frame.to, frame.from + 250);
    const seconds = Math.max(0.001, (until - frame.from) / 1000);
    lines.push(`file '${frame.path.replace(/'/g, "'\\''")}'`, `duration ${seconds.toFixed(3)}`);
  }
  // The concat demuxer applies the last duration only when the file repeats.
  lines.push(`file '${track.at(-1).path.replace(/'/g, "'\\''")}'`);
  return `${lines.join('\n')}\n`;
}

function encode(listFile, out, vfr, extra = { inputs: [], filter: null, map: [] }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...extra.inputs];
  if (extra.filter) args.push('-filter_complex', extra.filter, ...extra.map);
  else args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  args.push(...vfr, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  const r = run('ffmpeg', args);
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${out}: ${r.stderr.trim().slice(0, 400)}`);
  chmodSync(out, 0o600);
}

/** Presentation times (s) of every frame in a video, and its duration. */
export function probeFrames(file) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time,duration_time', '-of', 'csv=p=0', file]);
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.trim().slice(0, 300)}`);
  const frames = r.stdout
    .split('\n')
    .map((line) => line.split(','))
    .filter((cols) => cols[0] && cols[0] !== 'N/A')
    .map(([pts, duration]) => ({ pts: Number(pts), duration: Number(duration) || 0 }))
    .sort((a, b) => a.pts - b.pts);
  const fmt = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return { pts: frames.map((f) => f.pts), duration: Number(fmt.stdout.trim()) };
}

/**
 * Where a hold sits in its page's video: it passes when one frame starts at or
 * before the window, none starts inside it, and the video lasts past its end.
 */
export function checkHold(hold, t0, probe) {
  const start = (hold.from - t0) / 1000;
  const end = (hold.to - t0) / 1000;
  const inside = probe.pts.filter((p) => p > start + EDGE_S && p < end - EDGE_S);
  const covered = probe.pts.some((p) => p <= start + EDGE_S);
  const long = probe.duration >= end - EDGE_S;
  return { start, end, ok: covered && long && inside.length === 0, changesInside: inside.length };
}

function chaptersFile(dir, chapters, t0, endAt) {
  const sorted = [...chapters].sort((a, b) => a.at - b.at);
  const lines = [';FFMETADATA1'];
  for (let i = 0; i < sorted.length; i++) {
    const start = Math.max(0, sorted[i].at - t0);
    const end = Math.max(start + 1, (i + 1 < sorted.length ? sorted[i + 1].at : endAt) - t0);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${sorted[i].label.replace(/[=;#\\\n]/g, ' ')}`);
  }
  const file = join(dir, 'chapters.txt');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

/**
 * Encode one invocation and check its holds. Returns the report; `failures`
 * lists every reason the footage does not meet the policy.
 */
export async function encodeInvocation({ env = process.env, invocation = invocationId(env), allowTestPolicy = false, log = () => {} } = {}) {
  const { sessions, problems } = loadInvocation(rawRoot(env), invocation);
  const failures = [...problems];
  const out = privateDir(join(videoRoot(env), invocation));
  const report = { invocation, policyFloor: OWNER_POLICY, pages: {}, combined: null, holds: [], failures };
  if (!sessions.length) {
    failures.push('no recorded session to encode');
    writeFileSync(join(out, 'C-tips-video.json'), JSON.stringify(report, null, 1), { mode: 0o600 });
    return report;
  }
  for (const session of sessions) {
    for (const key of ['tap', 'settled', 'result']) {
      if (!allowTestPolicy && !(session.lane.policy?.[key] >= OWNER_POLICY[key])) {
        failures.push(`session ${session.name} ran a ${key} hold policy below the owner's ${OWNER_POLICY[key]} ms`);
      }
    }
  }
  const vfr = vfrArgs();
  const firstFrame = sessions.flatMap((s) => Object.values(s.pages).flat())[0];
  if (!firstFrame) {
    failures.push('the sessions hold no frames');
    return report;
  }
  const size = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', firstFrame.path]);
  const [width, height] = size.stdout.trim().split(',').map(Number);
  const gap = gapFrame(out, width, height);
  const pages = [...new Set(sessions.flatMap((s) => Object.keys(s.pages)))].sort();
  const holds = sessions.flatMap((s) => s.lane.holds ?? []);

  for (const page of pages) {
    const track = pageTrack(sessions, page, gap);
    if (!track.length) continue;
    const list = join(out, `${page}.ffconcat`);
    writeFileSync(list, concatList(track), { mode: 0o600 });
    const file = join(out, `${page}.mp4`);
    log(`encoding ${page} (${track.length} frames)`);
    encode(list, file, vfr);
    const probe = probeFrames(file);
    const t0 = track[0].from;
    report.pages[page] = { file, frames: track.length, seconds: probe.duration };
    for (const hold of holds.filter((h) => h.wallet === page)) {
      const where = checkHold(hold, t0, probe);
      report.holds.push({ ...hold, video: `${page}.mp4`, start: where.start, end: where.end, ok: hold.static && where.ok });
      if (!hold.static) failures.push(`${page}: the ${hold.type} hold "${hold.label}" never found a still screen`);
      else if (!where.ok) failures.push(`${page}: the ${hold.type} hold "${hold.label}" changes ${where.changesInside} time(s) in the video`);
    }
  }
  for (const hold of holds.filter((h) => !pages.includes(h.wallet))) {
    failures.push(`${hold.wallet}: the ${hold.type} hold "${hold.label}" has no recorded page`);
  }

  // Alice, bob and carol on one clock, with the lane's chapters.
  const main = MAIN_PAGES.filter((p) => pages.includes(p));
  if (main.length) {
    const startAt = Math.min(...main.map((p) => pageTrack(sessions, p, gap)[0].from));
    const endAt = Math.max(...main.map((p) => pageTrack(sessions, p, gap).at(-1).to));
    const lists = main.map((p) => {
      const list = join(out, `${p}.aligned.ffconcat`);
      writeFileSync(list, concatList(pageTrack(sessions, p, gap, startAt, endAt)), { mode: 0o600 });
      return list;
    });
    const chapters = chaptersFile(out, sessions.flatMap((s) => s.lane.chapters ?? []), startAt, endAt);
    const file = join(out, 'C-tips-all.mp4');
    log(`encoding the side-by-side video (${main.join(', ')})`);
    const inputs = lists.slice(1).flatMap((l) => ['-f', 'concat', '-safe', '0', '-i', l]);
    const metaIndex = lists.length;
    const filter =
      main.length > 1
        ? `${main.map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${main.length},scale=trunc(iw/2)*2:trunc(ih/2)*2[v]`
        : '[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[v]';
    encode(lists[0], file, vfr, {
      inputs: [...inputs, '-f', 'ffmetadata', '-i', chapters],
      filter,
      map: ['-map', '[v]', '-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex)],
    });
    const probe = probeFrames(file);
    report.combined = { file, pages: main, seconds: probe.duration };
    if (probe.duration < (endAt - startAt) / 1000 - 1) failures.push('the side-by-side video is shorter than the run');
  }
  writeFileSync(join(out, 'C-tips-video.json'), JSON.stringify(report, null, 1), { mode: 0o600 });
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--invocation');
  const invocation = at >= 0 ? args[at + 1] : invocationId();
  const report = await encodeInvocation({ invocation, allowTestPolicy: args.includes('--allow-test-policy'), log: (m) => console.log(m) });
  console.log(`C-tips video: ${Object.keys(report.pages).length} page video(s), ${report.holds.length} hold(s) checked`);
  if (report.failures.length) {
    console.error(`C-tips video check FAILED:\n${report.failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}
