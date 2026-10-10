/**
 * Pin the build under test to the staged release candidate.
 *
 * A manifest version proves nothing about which build is loaded: any local
 * build of the release commit says 0.3.1 too. This check proves the unpacked
 * directory in EXTENSION_DIST is exactly the staged Chrome zip:
 *   1. the zip's SHA-256 equals the pinned value (run 11204 by default), and,
 *      when the release provenance sits beside it, the provenance names the
 *      same hash;
 *   2. every file in the zip exists in the directory with identical bytes;
 *   3. the directory holds nothing the zip does not (Finder's .DS_Store aside).
 *
 * Self-contained: a small reader for the zip's central directory, no unzip
 * binary. Reads and hashes about 10 MB, so it runs before anything slow.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** The v0.3.1 release candidate: run 11204's Chrome zip. */
export const PINNED_CHROME_ZIP_SHA256 = 'e64fb7aca1012b10cc078fcdc272685e0966e356297a5c8aa59485aa08485776';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every file entry of a zip (directories skipped), inflated. Refuses what it cannot read. */
export function readZipEntries(zip) {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archives are not supported here');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (name.split('/').some((part) => part === '..' || part === '') || name.startsWith('/')) {
      throw new Error(`zip entry has an unsafe path: ${name.slice(0, 80)}`);
    }
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip entry ${name.slice(0, 80)} uses unsupported compression ${method}`);
    if (data.length !== size) throw new Error(`zip entry ${name.slice(0, 80)} inflated to the wrong size`);
    entries.push({ name, data });
  }
  return entries;
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/**
 * Prove `dir` is the unpacked `zip` and that `zip` is the pinned candidate.
 * Returns public facts for the run's evidence; throws, naming the cause, otherwise.
 */
export function verifyUnpackedRelease({ dir, zip, expectedSha256 }) {
  const zipPath = resolve(zip);
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) {
    throw new Error(`release zip not found at ${zipPath}; set E2E_RELEASE_ZIP to the staged Chrome zip`);
  }
  const bytes = readFileSync(zipPath);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`release zip ${basename(zipPath)} has SHA-256 ${actual}, not the pinned ${expectedSha256}`);
  }
  let sourceCommit = null;
  const provenance = readdirSync(dirname(zipPath)).find((f) => /^RELEASE-PROVENANCE-extension-.*\.json$/.test(f));
  if (provenance) {
    const p = JSON.parse(readFileSync(join(dirname(zipPath), provenance), 'utf8'));
    const named = (p.artifacts ?? []).find((a) => a.name === basename(zipPath));
    if (!named || named.sha256 !== actual) {
      throw new Error(`${provenance} does not name ${basename(zipPath)} with SHA-256 ${actual}`);
    }
    sourceCommit = typeof p.source_commit === 'string' ? p.source_commit : null;
  }

  const root = resolve(dir);
  const entries = readZipEntries(bytes);
  const problems = [];
  for (const { name, data } of entries) {
    const file = join(root, ...name.split('/'));
    if (!existsSync(file)) problems.push(`missing ${name}`);
    else if (sha256(readFileSync(file)) !== sha256(data)) problems.push(`differs ${name}`);
  }
  const inZip = new Set(entries.map((e) => e.name));
  for (const name of filesUnder(root)) {
    if (!inZip.has(name) && basename(name) !== '.DS_Store') problems.push(`extra ${name}`);
  }
  if (problems.length) {
    throw new Error(
      `EXTENSION_DIST is not the unpacked release zip (${problems.length} difference(s)): ` +
        `${problems.slice(0, 10).join('; ')}${problems.length > 10 ? '; ...' : ''}. Unpack the staged zip into an empty directory.`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  return { zipSha256: actual, files: entries.length, version: String(manifest.version ?? ''), sourceCommit };
}
