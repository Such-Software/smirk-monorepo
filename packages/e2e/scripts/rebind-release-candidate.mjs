#!/usr/bin/env node
/**
 * Re-bind every live lane to a new release candidate: write
 * fixtures/release-candidate.json from a staged, verified release.
 *
 *   node scripts/rebind-release-candidate.mjs --staged DIR --run ID --source SHA [--write]
 *
 *   --staged  the collected release, laid out as
 *             ~/Build/smirk-release/v<version>-run-<ID>/staged (the lanes
 *             derive the same path from the candidate)
 *   --run     the release run id the owner dispatched
 *   --source  the full canonical source commit the run was approved for
 *   --write   write the file; without it, only show what would change
 *
 * It refuses, naming the cause, unless all of these hold:
 *   1. scripts/release-artifacts.mjs verifies the whole staged release
 *      (every platform, at the build commit its extension provenance names);
 *   2. that provenance was approved for --source, and the build commit is a
 *      different (wrapper) commit;
 *   3. the Chrome and Firefox zips hash to what the provenance recorded;
 *   4. both zips' manifests carry the provenance version;
 *   5. the Chrome bundle is stamped with the source or the wrapper commit,
 *      and no stamp says -dirty;
 *   6. --staged is named for this version and run.
 * Nothing secret is read or printed: the inputs are public release files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyArtifacts } from '../../../scripts/release-artifacts.mjs';
import { readZipEntries } from '../fixtures/F-legacy-recovery-release.mjs';
import { CANDIDATE_FILE, parseReleaseCandidate } from '../fixtures/release-candidate.mjs';

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const GENERATED = 'by scripts/rebind-release-candidate.mjs from a verified staged release; do not edit by hand';

export class RebindRefusal extends Error {}
const refuse = (reason) => {
  throw new RebindRefusal(reason);
};

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function manifestVersion(zipPath, label) {
  const entry = readZipEntries(readFileSync(zipPath)).find((e) => e.name === 'manifest.json');
  if (!entry) refuse(`the ${label} zip has no manifest.json`);
  return JSON.parse(entry.data.toString('utf8')).version;
}

/** The build stamps in the Chrome bundle: which short commits appear, and any -dirty one. */
export function bundleStamps(zipPath, shortCommits) {
  const text = readZipEntries(readFileSync(zipPath))
    .filter((e) => /\.(m?js|html)$/.test(e.name))
    .map((e) => e.data.toString('utf8'))
    .join('\n');
  const found = shortCommits.filter((c) => new RegExp(`["'\`]${c}[0-9a-f]*(-dirty)?["'\`]`).test(text));
  const dirty = shortCommits.map((c) => text.match(new RegExp(`\\b${c}[0-9a-f]*-dirty\\b`))?.[0]).find(Boolean) ?? null;
  return { found, dirty };
}

/**
 * The candidate document for a staged release, or a refusal. `verify` is
 * scripts/release-artifacts.mjs verifyArtifacts (tests pass their own).
 */
export function candidateFromStaged({ staged, run, source, verify = verifyArtifacts }) {
  const dir = resolve(staged ?? '');
  if (!staged || !existsSync(dir)) refuse('--staged must name the collected release directory');
  if (!/^[1-9]\d{0,9}$/.test(String(run ?? ''))) refuse('--run must be the numeric release run id');
  if (!FULL_COMMIT.test(source ?? '')) refuse('--source must be the full 40-character canonical source commit');

  const provenanceFile = extensionReceipt(dir);
  const provenance = JSON.parse(readFileSync(join(dir, provenanceFile), 'utf8'));
  const version = provenance.version;
  const wrapper = provenance.source_commit;
  if (!FULL_COMMIT.test(wrapper ?? '')) refuse('the extension provenance names no full build commit');

  const label = `v${version}-run-${run}`;
  if (basename(dir) !== 'staged' || basename(dirname(dir)) !== label) {
    refuse(`--staged must be ~/Build/smirk-release/${label}/staged, where every lane looks for this candidate`);
  }

  try {
    verify(dir, version, wrapper);
  } catch (error) {
    refuse(`the staged release does not verify: ${error instanceof Error ? error.message : 'unknown reason'}`);
  }
  if (provenance.approved_source_commit !== source) {
    refuse(`the staged release was approved for source ${String(provenance.approved_source_commit).slice(0, 12)}, not ${source.slice(0, 12)}`);
  }
  if (wrapper === source) refuse('the build commit equals the source; a release builds through its Builds wrapper');

  const zips = {};
  for (const target of ['chrome', 'firefox']) {
    const file = `smirk-wallet-${target}-v${version}.zip`;
    const path = join(dir, file);
    if (!existsSync(path)) refuse(`${file} is missing from the staged release`);
    const recorded = (provenance.artifacts ?? []).find((a) => a?.name === file)?.sha256;
    const actual = sha256(path);
    if (recorded !== actual) refuse(`${file} hashes to ${actual.slice(0, 12)}, not the ${String(recorded ?? 'unrecorded').slice(0, 12)} its provenance recorded`);
    const shown = manifestVersion(path, target);
    if (shown !== version) refuse(`the ${target} zip's manifest says ${String(shown).slice(0, 20)}, not ${version}`);
    zips[target] = { file, sha256: actual, path };
  }

  const shorts = [source.slice(0, 7), wrapper.slice(0, 7)];
  const stamps = bundleStamps(zips.chrome.path, shorts);
  if (stamps.dirty) refuse(`the Chrome bundle is stamped ${stamps.dirty}: it was built from a modified tree`);
  if (stamps.found.length === 0) refuse(`the Chrome bundle carries neither ${shorts.join(' nor ')} as its build stamp`);

  const candidate = {
    _generated: GENERATED,
    version,
    run: String(run),
    sourceCommit: source,
    buildsWrapper: wrapper,
    chromeZip: { file: zips.chrome.file, sha256: zips.chrome.sha256 },
    firefoxZip: { file: zips.firefox.file, sha256: zips.firefox.sha256 },
  };
  parseReleaseCandidate(candidate);
  return candidate;
}

/** The one extension provenance file of the staged release. */
function extensionReceipt(dir) {
  const matches = readdirSync(dir).filter((n) => /^RELEASE-PROVENANCE-extension-v\d+\.\d+\.\d+\.json$/.test(n));
  if (matches.length === 0) refuse('the staged directory has no extension provenance (RELEASE-PROVENANCE-extension-v<version>.json)');
  if (matches.length > 1) refuse('the staged directory holds more than one extension provenance');
  return matches[0];
}

export function serialize(candidate) {
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

/** The fields that would change, as "field: old -> new" lines. */
export function changes(before, after) {
  const flat = (o) => ({
    version: o.version,
    run: o.run,
    sourceCommit: o.sourceCommit,
    buildsWrapper: o.buildsWrapper,
    'chromeZip.sha256': o.chromeZip?.sha256,
    'firefoxZip.sha256': o.firefoxZip?.sha256,
  });
  const a = flat(before);
  const b = flat(after);
  return Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? '(none)'} -> ${b[k]}`);
}

function parseArgs(argv) {
  const out = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--')) refuse(`${arg} needs a value`);
      return next;
    };
    if (arg === '--staged') out.staged = value();
    else if (arg === '--run') out.run = value();
    else if (arg === '--source') out.source = value();
    else if (arg === '--write') out.write = true;
    else refuse(`unknown argument ${arg}; see the header of this script`);
  }
  return out;
}

export function main(argv, file = CANDIDATE_FILE) {
  const args = parseArgs(argv);
  const candidate = candidateFromStaged(args);
  const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const diff = changes(before, candidate);
  console.log(`release candidate v${candidate.version} run ${candidate.run}: source ${candidate.sourceCommit.slice(0, 12)}, build ${candidate.buildsWrapper.slice(0, 12)}; the staged release verifies`);
  console.log(diff.length ? diff.map((d) => `  ${d}`).join('\n') : '  no change');
  if (!args.write) {
    console.log('not written (dry run); pass --write to re-bind the lanes');
    return candidate;
  }
  writeFileSync(file, serialize(candidate), { mode: 0o644 });
  console.log(`wrote ${file}`);
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
