/**
 * Which build the E-swaps live lane drove, proved from the files rather than
 * taken from a label.
 *
 * The lane loads an unpacked extension (EXTENSION_DIST). With EXTENSION_ZIP
 * naming the release zip it came from, every file in the zip is inflated and
 * compared byte for byte with the unpacked directory, and the directory may
 * hold nothing the zip does not. The zip's SHA-256 is recorded, and checked
 * against E2E_EXPECT_ZIP_SHA256 when that is set. Money tests and recorded
 * runs require this proof (fixtures/E-swaps-live.ts), so their evidence
 * names the exact release artifact that spent the funds or made the footage.
 *
 * Reads only public build files. No dependency: the zip's central directory
 * is parsed here (no ZIP64, no encryption, store or deflate only, which is
 * what the release workflow writes).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, posix, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Files the host may drop into an unpacked directory that are not the build. */
const HOST_LITTER = new Set(['.DS_Store']);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Every file in a zip, by name, with its uncompressed bytes. */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported here');
  const files = new Map();
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('corrupt zip central directory');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error('encrypted zip entries are not supported');
    if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('a zip entry has an unsafe path');
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(local) !== LOCAL) throw new Error('corrupt zip local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip compression method ${method} is not supported`);
    if (data.length !== size) throw new Error('a zip entry inflated to the wrong size');
    if (files.has(name)) throw new Error('a zip names the same file twice');
    files.set(name, data);
  }
  return files;
}

/** Every regular file under `dir`, as posix paths relative to it. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, relative));
    else if (entry.isFile()) out.push(relative.split(sep).join(posix.sep));
    else throw new Error('the unpacked build holds something that is not a file or directory');
  }
  return out;
}

/**
 * Prove the unpacked build. Throws with the reason when the directory is not
 * exactly the zip, or the zip is not the expected one.
 */
export function proveBuild({ distDir, zipPath, expectZipSha256 }) {
  const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
  const distFiles = listFiles(distDir).filter((f) => !HOST_LITTER.has(posix.basename(f))).sort();
  const tree = createHash('sha256');
  for (const f of distFiles) tree.update(`${f}\0${sha256(readFileSync(join(distDir, f)))}\n`);
  const proof = {
    manifestName: String(manifest.name ?? ''),
    manifestVersion: String(manifest.version ?? ''),
    distFiles: distFiles.length,
    distTreeSha256: tree.digest('hex'),
    zip: null,
  };
  if (!zipPath) {
    if (expectZipSha256) throw new Error('E2E_EXPECT_ZIP_SHA256 is set but EXTENSION_ZIP is not');
    return proof;
  }
  const buffer = readFileSync(zipPath);
  const zipSha256 = sha256(buffer);
  if (expectZipSha256 && zipSha256 !== expectZipSha256.trim().toLowerCase()) {
    throw new Error('EXTENSION_ZIP is not the expected release zip (SHA-256 differs from E2E_EXPECT_ZIP_SHA256)');
  }
  const files = readZip(buffer);
  for (const [name, data] of files) {
    let local;
    try {
      local = readFileSync(join(distDir, ...name.split('/')));
    } catch {
      throw new Error(`the unpacked build lacks ${name} from the zip`);
    }
    if (!local.equals(data)) throw new Error(`the unpacked build's ${name} differs from the zip`);
  }
  const extra = distFiles.filter((f) => !files.has(f));
  if (extra.length) throw new Error(`the unpacked build holds ${extra.length} file(s) the zip does not, first ${extra[0]}`);
  proof.zip = { file: basename(zipPath), sha256: zipSha256, entries: files.size, matchesDist: true };
  return proof;
}
