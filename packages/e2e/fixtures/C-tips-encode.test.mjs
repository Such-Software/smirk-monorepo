// The C-tips encoder end to end: record real pages with the guarded recorder
// (test-length holds), encode them, and check that every hold is present in the
// ENCODED video, that a hold straddling a change fails, and that a policy below
// the owner's fails unless a test explicitly allows it. Needs ffmpeg and ffprobe.
//
//   node --import tsx --test packages/e2e/fixtures/C-tips-encode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const TEST_POLICY = { tap: 400, settled: 800, result: 1_200 };
const INVOCATION = 'offline-encode';

test('recorded holds survive encoding as still frames, and the check catches what is not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c-tips-encode-'));
  const env = { FOOTAGE: 'guarded', FOOTAGE_DIR: root, C_TIPS_INVOCATION: INVOCATION };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const browser = await chromium.launch({ channel: 'chromium' });
  t.after(async () => {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { GuardedFootage } = await import('./C-tips-footage.ts');
  const { encodeInvocation } = await import('../scripts/C-tips-encode.mjs');

  const footage = new GuardedFootage({ policy: TEST_POLICY, staticPatienceMs: 4_000 });
  const pages = {};
  for (const [name, color] of [['alice', '#203040'], ['bob', '#302040']]) {
    pages[name] = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await pages[name].setContent(`<body style="background:${color};color:#eee;font:20px sans-serif"><p id="s">Home</p><button id="b">Tip</button></body>`);
    footage.attach(name, pages[name]);
  }
  footage.chapter('Encode test: alice taps');
  await footage.settled(pages.alice, 'Home balances');
  await pages.alice.evaluate(() => {
    document.getElementById('b').onclick = () => (document.getElementById('s').textContent = 'Composer');
  });
  await footage.tap(pages.alice.locator('#b'), 'Open the tip composer');
  footage.chapter('Encode test: bob holds a result');
  await footage.result(pages.bob, 'Tip claimed');
  await pages.alice.evaluate(() => (document.getElementById('s').textContent = 'Done'));
  await footage.result(pages.alice, 'Tip link created');
  const summary = await footage.close();
  assert.equal(summary.nonStaticHolds, 0);
  const lanePath = join(summary.dir, 'lane.json');
  const lane = JSON.parse(readFileSync(lanePath, 'utf8'));
  assert.equal(lane.holds.length, 5, 'settled, tap and its settle, and two results');

  const good = await encodeInvocation({ env, allowTestPolicy: true });
  assert.deepEqual(good.failures, [], 'every hold is a still stretch of the encoded video');
  assert.equal(good.holds.length, lane.holds.length);
  assert.ok(good.holds.every((h) => h.ok));
  for (const name of ['alice', 'bob']) {
    const file = good.pages[name].file;
    assert.ok(existsSync(file), `${name}.mp4 exists`);
    assert.equal(statSync(file).mode & 0o777, 0o600, `${name}.mp4 is owner-only`);
  }
  // Real time: the video lasts as long as the page was recorded, dead air included.
  const aliceHolds = lane.holds.filter((h) => h.wallet === 'alice');
  const span = (Math.max(...aliceHolds.map((h) => h.to)) - Math.min(...aliceHolds.map((h) => h.from))) / 1000;
  assert.ok(good.pages.alice.seconds >= span - 0.2, `alice's video (${good.pages.alice.seconds} s) covers her holds (${span} s)`);
  assert.ok(good.combined && existsSync(good.combined.file), 'the side-by-side video exists');
  const chapters = spawnSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', good.combined.file], { encoding: 'utf8' });
  assert.equal(JSON.parse(chapters.stdout).chapters.length, 2, 'the lane chapters are in the side-by-side video');

  // The owner's policy is the floor: a shortened policy fails without the test switch.
  const strict = await encodeInvocation({ env });
  assert.ok(strict.failures.some((f) => /below the owner/.test(f)), 'a test-length policy fails the real check');

  // A hold whose window straddles a change in the video fails.
  const tap = lane.holds.find((h) => h.type === 'tap');
  const settle = lane.holds.find((h) => h.type === 'settled' && h.label === 'Open the tip composer');
  lane.holds.push({ ...tap, label: 'Straddles the tap', to: settle.to });
  writeFileSync(lanePath, JSON.stringify(lane));
  const tampered = await encodeInvocation({ env, allowTestPolicy: true });
  assert.ok(tampered.failures.some((f) => /Straddles the tap.*changes/.test(f)), 'the straddling hold is caught in the video');
});

// A few still frames of very different lengths once encoded as an MP4 whose
// sample durations summed to 3.7 s for 5.8 s of footage: libx264 B-frame
// reordering at variable frame rate. The recorded test above hit it about one
// run in eight; this is that shape, fixed, so it fails every time it regresses.
test('a side-by-side of a few long still frames keeps the full length of the run', async (t) => {
  const { concatList, encodeSideBySide, probeFrames } = await import('../scripts/C-tips-encode.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'c-tips-side-by-side-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const still = (color) => {
    const file = join(dir, `${color}.jpg`);
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${color}:s=380x600`, '-frames:v', '1', file]);
    assert.equal(made.status, 0, 'ffmpeg draws a still frame');
    return file;
  };
  const t0 = 1_700_000_000_000;
  const tracks = {
    alice: [
      { path: still('203040'), from: t0, to: t0 + 1_823 },
      { path: still('302040'), from: t0 + 1_823, to: t0 + 4_574 },
      { path: still('405060'), from: t0 + 4_574, to: t0 + 5_825 },
    ],
    bob: [
      { path: still('0d0b14'), from: t0, to: t0 + 52 },
      { path: still('506070'), from: t0 + 52, to: t0 + 5_825 },
    ],
  };
  const lists = Object.entries(tracks).map(([name, track]) => {
    const list = join(dir, `${name}.ffconcat`);
    writeFileSync(list, concatList(track));
    return list;
  });
  const file = join(dir, 'side-by-side.mp4');
  encodeSideBySide(lists, file);
  const probe = probeFrames(file);
  assert.ok(probe.duration >= 5.825 - 0.1, `the side-by-side lasts the whole run (${probe.duration} s of 5.825 s)`);
  assert.ok(probe.pts.length < 20, 'each still screen stays one frame (variable frame rate)');
});
