// One release candidate for every live lane: its document is validated, and no
// lane keeps its own copy of a hash, a run number or a staging path.
// Run: node --test packages/e2e/fixtures/release-candidate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_FILE, RC, RC_FOOTAGE_ROOT, parseReleaseCandidate } from './release-candidate.mjs';
import { RELEASE as DRIVER } from '../scripts/live-v031.mjs';
import { FOOTAGE_ROOT as H_FOOTAGE, RELEASE as H } from './H-cross-browser-desktop-policy.mjs';
import { PINNED_CHROME_ZIP_SHA256 } from './F-legacy-recovery-release.mjs';
import { DEFAULT_RELEASE_ZIP } from './F-legacy-recovery-lane.mjs';
import { DEFAULT_RUN_LABEL } from './C-tips-run.mjs';

const E2E = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the stored candidate is well formed', () => {
  const raw = JSON.parse(readFileSync(CANDIDATE_FILE, 'utf8'));
  assert.doesNotThrow(() => parseReleaseCandidate(raw));
  assert.match(raw._generated ?? '', /rebind-release-candidate/, 'it says which script writes it');
});

test('a malformed candidate refuses and names the field', () => {
  const good = JSON.parse(readFileSync(CANDIDATE_FILE, 'utf8'));
  const broken = [
    ['version', { ...good, version: '0.3' }],
    ['run', { ...good, run: '0' }],
    ['sourceCommit', { ...good, sourceCommit: good.sourceCommit.slice(0, 8) }],
    ['buildsWrapper', { ...good, buildsWrapper: good.sourceCommit }],
    ['chromeZip.file', { ...good, chromeZip: { ...good.chromeZip, file: 'other.zip' } }],
    ['chromeZip.sha256', { ...good, chromeZip: { ...good.chromeZip, sha256: 'ABC' } }],
    ['firefoxZip.sha256', { ...good, firefoxZip: { ...good.firefoxZip, sha256: good.chromeZip.sha256 } }],
  ];
  for (const [field, doc] of broken) assert.throws(() => parseReleaseCandidate(doc), (e) => e.message.includes(field), field);
  assert.throws(() => parseReleaseCandidate(null));
});

test('every lane pin is the candidate', () => {
  assert.equal(DRIVER.version, RC.version);
  assert.equal(String(DRIVER.run), RC.run);
  assert.ok(RC.sourceCommit.startsWith(DRIVER.sourceCommit));
  assert.equal(DRIVER.stagedDir, RC.stagedDir);
  assert.equal(DRIVER.chromeSha256, RC.chromeZip.sha256);
  assert.equal(DRIVER.firefoxSha256, RC.firefoxZip.sha256);
  assert.equal(H.run, RC.run);
  assert.equal(H.sourceCommit, RC.sourceCommit);
  assert.equal(H.buildsWrapper, RC.buildsWrapper);
  assert.equal(H.chromeZip.sha256, RC.chromeZip.sha256);
  assert.equal(H.firefoxZip.sha256, RC.firefoxZip.sha256);
  assert.equal(H_FOOTAGE, RC_FOOTAGE_ROOT);
  assert.equal(PINNED_CHROME_ZIP_SHA256, RC.chromeZip.sha256);
  assert.equal(DEFAULT_RELEASE_ZIP, join(RC.stagedDir, RC.chromeZip.file));
  assert.equal(DEFAULT_RUN_LABEL, RC.runLabel);
});

/** Lane sources: everything but dependencies, tests, generated output and the candidate itself. */
function laneSources(dir = E2E) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...laneSources(path));
    else if (/\.(ts|mts|mjs|js)$/.test(entry.name) && !/\.test\.(mjs|ts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('no lane source keeps its own copy of the candidate', () => {
  const copies = [
    RC.chromeZip.sha256.slice(0, 8),
    RC.firefoxZip.sha256.slice(0, 8),
    RC.runLabel,
    `run-${RC.run}`,
    `run ${RC.run}`,
  ];
  const found = [];
  for (const file of laneSources()) {
    const text = readFileSync(file, 'utf8');
    for (const copy of copies) if (text.includes(copy)) found.push(`${relative(E2E, file)} holds ${copy}`);
  }
  assert.deepEqual(found, [], 'read the candidate from fixtures/release-candidate.mjs instead');
});
