/**
 * The release candidate every live lane tests, in one place.
 *
 * The values live in release-candidate.json, which only
 * scripts/rebind-release-candidate.mjs writes, from a staged release that
 * scripts/release-artifacts.mjs has verified. No lane keeps its own copy of a
 * hash, a run number or a staging path, so the lanes cannot disagree about
 * which build they drive (release-candidate.test.mjs checks that).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANDIDATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'release-candidate.json');

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const RUN = /^[1-9]\d{0,9}$/;

/** Validate the stored shape and add what follows from it. Throws, naming the field at fault. */
export function parseReleaseCandidate(raw) {
  const bad = (field) => {
    throw new Error(`release-candidate.json: ${field} is missing or malformed`);
  };
  if (!raw || typeof raw !== 'object') bad('the document');
  if (!VERSION.test(raw.version ?? '')) bad('version');
  if (!RUN.test(raw.run ?? '')) bad('run');
  if (!FULL_COMMIT.test(raw.sourceCommit ?? '')) bad('sourceCommit');
  if (!FULL_COMMIT.test(raw.buildsWrapper ?? '') || raw.buildsWrapper === raw.sourceCommit) bad('buildsWrapper');
  for (const [key, target] of [['chromeZip', 'chrome'], ['firefoxZip', 'firefox']]) {
    if (raw[key]?.file !== `smirk-wallet-${target}-v${raw.version}.zip`) bad(`${key}.file`);
    if (!SHA256.test(raw[key]?.sha256 ?? '')) bad(`${key}.sha256`);
  }
  if (raw.chromeZip.sha256 === raw.firefoxZip.sha256) bad('firefoxZip.sha256');
  const runLabel = `v${raw.version}-run-${raw.run}`;
  return Object.freeze({
    version: raw.version,
    run: raw.run,
    sourceCommit: raw.sourceCommit,
    buildsWrapper: raw.buildsWrapper,
    /** Short commits the build stamp may carry: the source, or its Builds wrapper. */
    stampCommits: Object.freeze([raw.sourceCommit.slice(0, 7), raw.buildsWrapper.slice(0, 7)]),
    runLabel,
    stagedDir: join(homedir(), 'Build', 'smirk-release', runLabel, 'staged'),
    chromeZip: Object.freeze({ file: raw.chromeZip.file, sha256: raw.chromeZip.sha256 }),
    firefoxZip: Object.freeze({ file: raw.firefoxZip.file, sha256: raw.firefoxZip.sha256 }),
  });
}

export const RC = parseReleaseCandidate(JSON.parse(readFileSync(CANDIDATE_FILE, 'utf8')));

/** The machine-local footage root of this candidate's runs. Never promoted. */
export const RC_FOOTAGE_ROOT = join(homedir(), 'Build', 'smirk-e2e', RC.runLabel, 'footage');
