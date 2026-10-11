/**
 * C-tips release binding: the live lane tests exactly the release candidate.
 *
 * The candidate is a byte-identical store zip, not a local build: its SHA-256
 * must equal the one recorded for the run (by default the candidate's Chrome
 * zip, release-candidate.json), its manifest must carry the release version, and it is unpacked
 * here, by the lane, into the run's private state directory. EXTENSION_DIST is
 * then set to that directory for every worker; an EXTENSION_DIST the operator
 * set to anything else is refused rather than silently tested instead.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateDir, stateDir } from './C-tips-run.mjs';
import { RC } from './release-candidate.mjs';

export const CANDIDATE = Object.freeze({
  zip: join(RC.stagedDir, RC.chromeZip.file),
  sha256: RC.chromeZip.sha256,
  version: RC.version,
});

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface VerifiedRelease {
  dist: string;
  zip: string;
  sha256: string;
  version: string;
}

/** Verify the candidate zip and unpack it; returns the directory to load. */
export async function verifyRelease(env: Record<string, string | undefined> = process.env): Promise<VerifiedRelease> {
  const zip = resolve((env.E2E_RELEASE_ZIP ?? '').trim() || CANDIDATE.zip);
  const expected = ((env.E2E_RELEASE_SHA256 ?? '').trim() || CANDIDATE.sha256).toLowerCase();
  const version = (env.E2E_RELEASE_VERSION ?? '').trim() || CANDIDATE.version;
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('E2E_RELEASE_SHA256 must be a SHA-256 in hex');
  if (!existsSync(zip)) throw new Error(`the release zip is not at ${zip}: set E2E_RELEASE_ZIP to the staged Chrome zip`);
  const actual = await sha256File(zip);
  if (actual !== expected) {
    throw new Error(`the release zip at ${zip} has SHA-256 ${actual}, not the candidate's ${expected}`);
  }
  const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error('unzip could not list the release zip');
  for (const entry of listing.stdout.split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('the release zip holds an unsafe path');
  }
  const dist = join(privateDir(join(stateDir(env), 'release')), `chrome-${expected.slice(0, 16)}`);
  rmSync(dist, { recursive: true, force: true });
  privateDir(dist);
  const unpack = spawnSync('unzip', ['-q', zip, '-d', dist], { encoding: 'utf8' });
  if (unpack.status !== 0) throw new Error('unzip could not unpack the release zip');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as { version?: string };
  if (manifest.version !== version) {
    throw new Error(`the release zip's manifest says version ${manifest.version}, not ${version}`);
  }
  const configured = (env.EXTENSION_DIST ?? '').trim();
  if (configured && resolve(configured) !== dist) {
    throw new Error('EXTENSION_DIST is set: the live lane loads only the release zip it verified; unset EXTENSION_DIST');
  }
  return { dist, zip, sha256: actual, version };
}
