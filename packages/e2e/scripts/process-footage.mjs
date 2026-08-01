#!/usr/bin/env node
/**
 * Turn raw e2e capture into editable demo clips.
 *
 * Playwright records the WHOLE test, at a hashed filename like
 * `page@39a6bef6…webm`. That is unusable as marketing material: nobody can tell
 * which scenario a clip is from, and the interesting seconds are buried in
 * waits, retries and teardown.
 *
 * This reads the `*.footage.json` manifests written by `fixtures/footage.ts`,
 * and for each one emits a clip that is:
 *   - named after the scenario,
 *   - trimmed to the marked region plus a little padding, so the dead air at the
 *     head and tail is gone,
 *   - accompanied by a chapter list of the marker offsets, so an editor can jump
 *     straight to the money moment.
 *
 * STORAGE CONTRACT (docs/engineering/developer-workstations.md): everything here
 * writes to `~/Build/smirk-monorepo/e2e/...`, which is machine-local and
 * disposable. Nothing is written to `~/Seafile/Marketing Media` automatically,
 * because rule 5 says only APPROVED deliverables belong there. Use `--promote`
 * once you have watched a clip and want to keep it.
 *
 * Usage:
 *   node scripts/process-footage.mjs                # trim + name into ~/Build
 *   node scripts/process-footage.mjs --promote      # copy approved clips to Seafile
 *   node scripts/process-footage.mjs --pad-ms 750   # padding around the marked region
 */

import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const BUILD = join(homedir(), 'Build', 'smirk-monorepo', 'e2e');
const VIDEO_DIR = process.env.CAPTURE_VIDEO_DIR ?? join(BUILD, 'videos');
const OUT_DIR = join(BUILD, 'footage');
const MARKETING = join(homedir(), 'Seafile', 'Marketing Media', 'smirk-wallet', 'e2e-clips');

const args = process.argv.slice(2);
const PROMOTE = args.includes('--promote');
const PAD_MS = Number(args[args.indexOf('--pad-ms') + 1]) || 600;
/**
 * With a single marker the trim would collapse to PAD either side, giving a
 * ~1s clip that shows the payoff with none of the action leading to it. Roll
 * back further so the viewer sees the flow arrive at the marked moment.
 * Specs with two or more markers already bracket their own region.
 */
const PRE_ROLL_MS = Number(args[args.indexOf('--pre-roll-ms') + 1]) || 2500;
/**
 * Playwright records EVERY page in the context, including blank tabs and the
 * service-worker page. Those come out as 0-2KB webm files that are pure noise
 * in a clip library, so drop them rather than transcoding them.
 */
const MIN_SOURCE_BYTES = Number(args[args.indexOf('--min-bytes') + 1]) || 8192;
/**
 * e2e runs at machine speed, so raw clips are unwatchably fast for a human.
 * Slow playback in POST rather than sleeping in the specs, which would tax every
 * CI run to serve marketing. 1.0 = real time, 2.0 = half speed.
 */
const SLOWDOWN = Number(args[args.indexOf('--slowdown') + 1]) || 2.0;
/**
 * Which pages are worth keeping. Playwright records EVERY page in the context:
 * the popup, but also offscreen workers and blank tabs that render as pure
 * white. Size alone was too crude a filter, so classify by URL.
 */
function pageRole(url) {
  if (!url) return 'unknown';
  if (/offscreen/i.test(url)) return 'offscreen';
  if (/approval/i.test(url)) return 'approval';
  if (/popup\.html/i.test(url)) return 'popup';
  if (/^chrome-extension:/.test(url)) return 'extension-other';
  if (/^https?:/.test(url)) return 'dapp';
  return 'blank';
}
/** Roles that make sense as demo footage. Everything else is discarded. */
const KEEP_ROLES = new Set(['popup', 'approval', 'dapp']);

function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!existsSync(VIDEO_DIR)) {
    console.error(`No capture directory at ${VIDEO_DIR}.\nRun the suite with CAPTURE_VIDEO=1 first.`);
    process.exit(1);
  }

  const manifests = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.footage.json'));
  if (!manifests.length) {
    console.error(
      `No *.footage.json in ${VIDEO_DIR}.\n` +
        `Specs need to call \`footage.mark('...')\` for a clip to be trimmable; ` +
        `without markers there is nothing to trim TO.`,
    );
    process.exit(1);
  }

  if (!ffmpegAvailable()) {
    console.error('ffmpeg not found on PATH; cannot trim. Install it or process the raw webm by hand.');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const produced = [];

  for (const m of manifests) {
    const manifest = JSON.parse(readFileSync(join(VIDEO_DIR, m), 'utf8'));
    const { scenario, markers, videos, status } = manifest;

    // A failed test's footage is for debugging, not for marketing. Keep it in
    // place but do not turn it into a clip.
    if (status !== 'passed') {
      console.log(`skip (status=${status}): ${scenario}`);
      continue;
    }
    if (!videos?.length || !markers?.length) continue;

    const lead = markers.length > 1 ? PAD_MS : PRE_ROLL_MS;
    const firstMs = Math.max(0, markers[0].tMs - lead);
    const lastMs = markers[markers.length - 1].tMs + PAD_MS;
    const name = m.replace(/\.footage\.json$/, '');

    // Older manifests stored bare path strings; new ones store {path,url}.
    const entries = videos.map((v) => (typeof v === 'string' ? { path: v, url: '' } : v));
    const kept = entries.filter((e) => {
      if (!existsSync(e.path)) return false;
      if (statSync(e.path).size < MIN_SOURCE_BYTES) return false;
      const role = pageRole(e.url);
      // With no URL recorded (older manifest) fall back to size alone.
      if (!e.url) return true;
      if (!KEEP_ROLES.has(role)) {
        console.log(`  skip ${role}: ${basename(e.path)}`);
        return false;
      }
      return true;
    });

    kept.forEach((entry, i) => {
      const src = entry.path;
      const role = pageRole(entry.url);
      const suffix = kept.length > 1 ? `--${role}${i > 0 && kept[i - 1] && pageRole(kept[i - 1].url) === role ? i + 1 : ''}` : '';
      const out = join(OUT_DIR, `${name}${suffix}.mp4`);
      try {
        execFileSync(
          'ffmpeg',
          [
            '-y', '-loglevel', 'error',
            '-i', src,
            '-ss', (firstMs / 1000).toFixed(2),
            '-to', (lastMs / 1000).toFixed(2),
            // Re-encode rather than stream-copy: webm cut on a non-keyframe
            // stream-copies into a clip that starts with a frozen frame.
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-pix_fmt', 'yuv420p',
            // Slow to a human-watchable pace. Applied after the trim so the
            // marker offsets in CHAPTERS.md scale with it (see below).
            ...(SLOWDOWN !== 1 ? ['-vf', `setpts=${SLOWDOWN}*PTS`] : []),
            out,
          ],
          { stdio: 'inherit' },
        );
        produced.push({ out, scenario, markers, clipStartMs: firstMs });
        console.log(
          `clip: ${basename(out)}  (${(((lastMs - firstMs) / 1000) * SLOWDOWN).toFixed(1)}s @${SLOWDOWN}x slower, ${markers.length} markers)`,
        );
      } catch {
        console.error(`  ffmpeg failed for ${src}`);
      }
    });
  }

  if (!produced.length) {
    console.log('\nNothing produced. Specs need footage.mark() calls and a passing run.');
    return;
  }

  // Chapter list so an editor can jump to each marked moment.
  writeFileSync(
    join(OUT_DIR, 'CHAPTERS.md'),
    '# Smirk e2e demo clips\n\n' +
      'Trimmed to the marked region. Offsets are from the START OF THE CLIP.\n\n' +
      produced
        .map(({ out, scenario, markers, clipStartMs }) => {
          // Must be the REAL trim start: single-marker clips roll back by
          // PRE_ROLL_MS, not PAD_MS, so recomputing here would skew every
          // chapter offset by the difference.
          const base = clipStartMs;
          return (
            `## ${scenario}\n\`${basename(out)}\`\n\n` +
            markers
              .map((k) => {
                // Offsets must scale with the slowdown or they point at the
                // wrong frame in the emitted clip.
                const t = ((k.tMs - base) / 1000) * SLOWDOWN;
                return `- ${t.toFixed(1)}s — ${k.name}${k.note ? ` (${k.note})` : ''}`;
              })
              .join('\n')
          );
        })
        .join('\n\n') +
      '\n',
    'utf8',
  );
  console.log(`\n${produced.length} clip(s) + CHAPTERS.md in ${OUT_DIR}`);

  if (!PROMOTE) {
    console.log(
      `\nNot promoted. Watch them, then run with --promote to copy into\n  ${MARKETING}\n` +
        `(storage contract rule 5: only approved deliverables go to Marketing Media.)`,
    );
    return;
  }

  mkdirSync(MARKETING, { recursive: true });
  for (const { out } of produced) copyFileSync(out, join(MARKETING, basename(out)));
  copyFileSync(join(OUT_DIR, 'CHAPTERS.md'), join(MARKETING, 'CHAPTERS.md'));
  console.log(`promoted ${produced.length} clip(s) to ${MARKETING}`);
}

main();
